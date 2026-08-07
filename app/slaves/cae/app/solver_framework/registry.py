from __future__ import annotations

import importlib
import json
from pathlib import Path
from typing import Any, Awaitable, Callable

from jsonschema import Draft202012Validator

from app.errors import CaeError
from app.solver_framework.models import SolverContext

Runner = Callable[[SolverContext], Awaitable[dict[str, Any]]]


class SolverRegistry:
    def __init__(self, entries: dict[tuple[str, str], dict[str, Any]]) -> None:
        self._entries = entries
        self._runners: dict[tuple[str, str], Runner] = {}

    @classmethod
    def discover(cls, root: Path | None = None) -> SolverRegistry:
        solvers_root = root or Path(__file__).resolve().parents[1] / "solvers"
        schema_path = Path(__file__).with_name("solver-manifest.schema.json")
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        validator = Draft202012Validator(schema)
        entries: dict[tuple[str, str], dict[str, Any]] = {}
        for path in sorted(solvers_root.glob("*/manifest.json")):
            try:
                manifest = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise RuntimeError(f"Invalid CAE solver manifest {path}: {exc}") from exc
            errors = sorted(validator.iter_errors(manifest), key=lambda error: list(error.absolute_path))
            if errors:
                location = ".".join(str(item) for item in errors[0].absolute_path) or "<root>"
                raise RuntimeError(f"Invalid CAE solver manifest {path} at {location}: {errors[0].message}")
            descriptor = manifest["descriptor"]
            identity = (descriptor["name"], descriptor["version"])
            if identity in entries:
                raise RuntimeError(f"Duplicate CAE kernel identity {identity[0]}@{identity[1]}")
            _validate_implementation_path(path, manifest["implementation"])
            entries[identity] = manifest
        if not entries:
            raise RuntimeError(f"No CAE solver manifests found under {solvers_root}")
        return cls(entries)

    def manifests(self) -> list[dict[str, Any]]:
        return [self._entries[identity] for identity in sorted(self._entries)]

    def descriptor(self, name: Any, version: Any) -> dict[str, Any]:
        entry = self._entries.get((name, version))
        if entry is None:
            raise CaeError("kernel_not_found", f"CAE kernel {name}@{version} is not registered")
        return entry["descriptor"]

    def runner(self, name: Any, version: Any) -> Runner:
        identity = (name, version)
        if identity in self._runners:
            return self._runners[identity]
        entry = self._entries.get(identity)
        if entry is None:
            raise CaeError("kernel_not_found", f"CAE kernel {name}@{version} is not registered")
        module_name, attribute = entry["implementation"].split(":", 1)
        runner = getattr(importlib.import_module(module_name), attribute, None)
        if not callable(runner):
            raise RuntimeError(f"CAE solver implementation {entry['implementation']} is not callable")
        self._runners[identity] = runner
        return runner

    async def run(
        self,
        task: dict[str, Any],
        state: Any,
        inputs: dict[str, Any],
        world: dict[str, Any],
        progress: Callable[[Any], Awaitable[None]],
    ) -> dict[str, Any]:
        kernel = task.get("kernel") or {}
        config = task.get("config")
        if not isinstance(config, dict):
            raise CaeError("invalid_task", "kernel task has no normalized config")
        name, version = kernel.get("name"), kernel.get("version")
        descriptor = self.descriptor(name, version)
        result = await self.runner(name, version)(
            SolverContext(config, state, inputs, world, progress, descriptor)
        )
        return result if "state" in result else {"state": state, **result}


def _validate_implementation_path(manifest_path: Path, implementation: str) -> None:
    module_name, _ = implementation.split(":", 1)
    directory = manifest_path.parent.name
    prefix = f"app.solvers.{directory}."
    if not module_name.startswith(prefix):
        raise RuntimeError(
            f"CAE solver implementation {implementation} must be inside app.solvers.{directory}"
        )
    relative = module_name.removeprefix(prefix).split(".")
    implementation_path = manifest_path.parent.joinpath(*relative).with_suffix(".py")
    if not implementation_path.is_file():
        raise RuntimeError(f"CAE solver implementation file is missing: {implementation_path}")


registry = SolverRegistry.discover()
