from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any


SLAVES_DIR = Path(__file__).resolve().parents[2] / "slaves"


def load_slave_manifests(slaves_dir: Path | None = None) -> dict[str, dict[str, Any]]:
    root = slaves_dir or SLAVES_DIR
    entries: list[tuple[Path, str, dict[str, Any]]] = []
    for path in sorted(root.glob("*/manifest.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Invalid slave manifest {path}: {error}") from error
        if not isinstance(payload, dict):
            raise RuntimeError(f"Invalid slave manifest {path}: root must be an object")
        for key in ("id", "name", "module"):
            if not isinstance(payload.get(key), str) or not payload[key].strip():
                raise RuntimeError(f"Invalid slave manifest {path}: {key} is required")
        slave_app_id = payload["id"].strip()
        entries.append((path, slave_app_id, payload))

    duplicates = sorted(
        slave_app_id
        for slave_app_id, count in Counter(entry[1] for entry in entries).items()
        if count > 1
    )
    if duplicates:
        raise RuntimeError(f"Duplicate slave manifest id: {', '.join(duplicates)}")

    manifests: dict[str, dict[str, Any]] = {}
    for path, slave_app_id, payload in entries:
        if slave_app_id != path.parent.name:
            raise RuntimeError(
                f"Invalid slave manifest {path}: id must match directory name {path.parent.name}"
            )
        startup_timeout = payload.get("startup_timeout_seconds")
        if startup_timeout is not None and (
            isinstance(startup_timeout, bool)
            or not isinstance(startup_timeout, (int, float))
            or startup_timeout <= 0
        ):
            raise RuntimeError(
                f"Invalid slave manifest {path}: startup_timeout_seconds must be positive"
            )
        manifests[slave_app_id] = payload
    if not manifests:
        raise RuntimeError(f"No slave manifests found under {root}")
    return manifests


def initialize_slave_registry(slaves_dir: Path | None = None) -> dict[str, dict[str, Any]]:
    return load_slave_manifests(slaves_dir)


def require_slave_app_id(slave_app_id: str) -> None:
    if slave_app_id not in load_slave_manifests():
        raise ValueError(f"Unknown slave_app_id: {slave_app_id}")


def registered_slave_app_ids() -> tuple[str, ...]:
    return tuple(sorted(load_slave_manifests()))
