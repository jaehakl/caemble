from __future__ import annotations

import json
import os
import subprocess
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
    job_mode: str = "webrtc"
    storage_version: int | None = None
    readiness_args: tuple[str, ...] = ()
    prepare_args: tuple[str, ...] = ()

    @property
    def python_executable(self) -> Path:
        if os.name == "nt":
            return self.project_dir / ".venv" / "Scripts" / "python.exe"
        return self.project_dir / ".venv" / "bin" / "python"

    @property
    def executable_ready(self) -> bool:
        try:
            self.check_ready()
            return True
        except (OSError, RuntimeError, subprocess.SubprocessError):
            return False

    def check_ready(self) -> None:
        self.run_command(self.readiness_args, timeout=15)

    def run_command(self, args: tuple[str, ...], *, timeout: float) -> str:
        executable = self.python_executable
        if not executable.is_file() or (os.name != "nt" and not os.access(executable, os.X_OK)):
            raise RuntimeError(f"Python environment unavailable: {executable}; {self.install_hint}")
        if not args:
            return ""
        probe = subprocess.run([str(executable), *args], cwd=self.project_dir,
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        if probe.returncode != 0:
            raise RuntimeError(probe.stderr.strip() or probe.stdout.strip() or f"Command exited with code {probe.returncode}.")
        return probe.stdout.strip()

    @property
    def install_hint(self) -> str:
        return f"cd {self.project_dir} && poetry install"


class SlaveAppRegistry:
    def __init__(self, apps: list[SlaveApp]) -> None:
        self.apps = {app.id: app for app in apps}
        if len(self.apps) != len(apps):
            raise ValueError("Launcher application IDs must be unique.")
        self.preparation_errors: dict[str, str] = {}
        self.reported_errors: dict[str, str] = {}

    def prepare(self) -> None:
        """Run once after recovery, before connecting or accepting any Jobs."""
        for app in self.apps.values():
            if not app.prepare_args:
                continue
            try:
                output = app.run_command(app.prepare_args, timeout=app.startup_timeout_seconds or 60)
                print(f"[{app.id}] Prepared: {output}", flush=True)
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                self.preparation_errors[app.id] = str(error)
                self.reported_errors[app.id] = str(error)
                print(f"[{app.id}] Preparation failed: {error}", flush=True)

    def ready_ids(self) -> list[str]:
        ready = []
        for app_id in self.ids():
            if app_id in self.preparation_errors:
                continue  # A working old bundle must not hide a failed update.
            try:
                self.require(app_id).check_ready()
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                message = str(error)
                if self.reported_errors.get(app_id) != message:
                    print(f"[{app_id}] Unavailable: {message}", flush=True)
                self.reported_errors[app_id] = message
            else:
                self.reported_errors.pop(app_id, None)
                ready.append(app_id)
        return ready

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
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        apps.append(parse_entrypoint(payload, manifest_path))
        entries = payload.get("entrypoints", [])
        if not isinstance(entries, list):
            raise ValueError(f"Invalid entrypoints in {manifest_path}")
        for entry in entries:
            if not isinstance(entry, dict) or not all(key in entry for key in ("id", "module", "job_mode")):
                raise ValueError(f"Entrypoints require id, module and job_mode in {manifest_path}")
            apps.append(parse_entrypoint(entry, manifest_path))
    return SlaveAppRegistry(apps)


def load_manifest(manifest_path: Path) -> SlaveApp:
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    return parse_entrypoint(payload, manifest_path)


def parse_entrypoint(payload: dict, manifest_path: Path) -> SlaveApp:
    """An entrypoint shares its manifest's environment, but declares its own mode."""
    if any(not isinstance(payload.get(key), str) or not payload[key].strip() for key in ("id", "module")):
        raise ValueError(f"Entrypoints require nonempty id and module in {manifest_path}")
    job_mode = payload.get("job_mode", "webrtc")
    if job_mode not in {"webrtc", "websocket"}:
        raise ValueError(f"Invalid job_mode in {manifest_path}")
    return SlaveApp(
        id=str(payload["id"]),
        name=str(payload.get("name") or payload["id"]),
        module=str(payload["module"]),
        project_dir=manifest_path.parent,
        job_mode=job_mode,
        storage_version=payload.get("storage_version"),
        readiness_args=tuple(payload.get("readiness_args", ())),
        prepare_args=tuple(payload.get("prepare_args", ())),
        startup_timeout_seconds=(
            float(payload["startup_timeout_seconds"])
            if payload.get("startup_timeout_seconds") is not None
            else None
        ),
    )


def default_plugins_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "slaves"
