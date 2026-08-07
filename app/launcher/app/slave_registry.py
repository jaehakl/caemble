from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SlaveApp:
    id: str
    name: str
    module: str
    project_dir: Path
    startup_timeout_seconds: float | None = None

    @property
    def python_executable(self) -> Path:
        if os.name == "nt":
            return self.project_dir / ".venv" / "Scripts" / "python.exe"
        return self.project_dir / ".venv" / "bin" / "python"

    @property
    def executable_ready(self) -> bool:
        executable = self.python_executable
        return executable.is_file() and (os.name == "nt" or os.access(executable, os.X_OK))

    @property
    def install_hint(self) -> str:
        return f"cd {self.project_dir} && poetry install"


class SlaveAppRegistry:
    def __init__(self, apps: list[SlaveApp]) -> None:
        self.apps = {app.id: app for app in apps}
        if len(self.apps) != len(apps):
            raise ValueError("duplicate slave app id")

    def ids(self) -> list[str]:
        return sorted(self.apps)

    def get(self, slave_app_id: str) -> SlaveApp | None:
        return self.apps.get(slave_app_id)

    def require(self, slave_app_id: str) -> SlaveApp:
        app = self.get(slave_app_id)
        if app is None:
            raise KeyError(slave_app_id)
        return app

    def worker_subprocess_args(self, slave_app_id: str) -> list[str]:
        app = self.require(slave_app_id)
        return [
            str(app.python_executable),
            "-m",
            app.module,
            "--worker",
        ]

    def metadata(self, slave_app_ids: list[str] | None = None) -> dict[str, Any]:
        slave_apps: dict[str, dict[str, float]] = {}
        for app_id in self.ids() if slave_app_ids is None else slave_app_ids:
            app = self.require(app_id)
            if app.startup_timeout_seconds is not None:
                slave_apps[app_id] = {"startup_timeout_seconds": app.startup_timeout_seconds}
        return {"slave_apps": slave_apps} if slave_apps else {}


def load_default_registry() -> SlaveAppRegistry:
    return load_registry(default_plugins_dir())


def load_registry(plugins_dir: Path) -> SlaveAppRegistry:
    apps: list[SlaveApp] = []
    for manifest_path in sorted(plugins_dir.glob("*/manifest.json")):
        apps.append(load_manifest(manifest_path))
    return SlaveAppRegistry(apps)


def load_manifest(manifest_path: Path) -> SlaveApp:
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    return SlaveApp(
        id=str(payload["id"]),
        name=str(payload.get("name") or payload["id"]),
        module=str(payload["module"]),
        project_dir=manifest_path.parent,
        startup_timeout_seconds=parse_startup_timeout_seconds(payload.get("startup_timeout_seconds"), manifest_path),
    )


def parse_startup_timeout_seconds(value: Any, manifest_path: Path) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f"{manifest_path}: startup_timeout_seconds must be a positive number")
    try:
        timeout = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{manifest_path}: startup_timeout_seconds must be a positive number") from exc
    if timeout <= 0:
        raise ValueError(f"{manifest_path}: startup_timeout_seconds must be positive")
    return timeout


def default_plugins_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "slaves"
