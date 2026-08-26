from __future__ import annotations

import copy
import importlib
from pathlib import Path
from typing import Any, Awaitable, Callable

from caemble_catalog import open_catalog

from app.errors import CaeError
from app.solver_framework.geometry import GeometryService
from app.solver_framework.models import SolverContext

Runner = Callable[[SolverContext], Awaitable[dict[str, Any]]]


class SolverRegistry:
    def __init__(self, entries: dict[tuple[str, str], dict[str, Any]]) -> None:
        self._entries = copy.deepcopy(entries)
        self._runners: dict[tuple[str, str], Runner] = {}

    @classmethod
    def discover(
        cls,
        catalog_path: Path | None = None,
        solvers_root: Path | None = None,
    ) -> SolverRegistry:
        del solvers_root
        catalog = open_catalog(catalog_path, immutable=True)
        try:
            manifests = catalog.solver_manifests()
        finally:
            catalog.close()
        return cls.from_manifests(manifests)

    @classmethod
    def from_manifests(
        cls,
        manifests: list[dict[str, Any]],
        *args: Any,
        solvers_root: Path | None = None,
    ) -> SolverRegistry:
        del args, solvers_root
        entries = {
            (manifest["descriptor"]["name"], manifest["descriptor"]["version"]): manifest
            for manifest in manifests
        }
        return cls(entries)

    def manifests(self) -> list[dict[str, Any]]:
        return [copy.deepcopy(self._entries[identity]) for identity in sorted(self._entries)]

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
        runner = getattr(importlib.import_module(module_name), attribute)
        self._runners[identity] = runner
        return runner

    async def run(
        self,
        task: dict[str, Any],
        state: Any,
        inputs: dict[str, Any],
        world: dict[str, Any],
        progress: Callable[[Any], Awaitable[None]],
        geometry: GeometryService | None = None,
    ) -> dict[str, Any]:
        kernel = task["kernel"]
        name, version = kernel["name"], kernel["version"]
        result = await self.runner(name, version)(
            SolverContext(
                task["config"],
                state,
                inputs,
                world,
                geometry or GeometryService(),
                progress,
                self.descriptor(name, version),
            )
        )
        return result if "state" in result else {"state": state, **result}


registry = SolverRegistry.discover()
