from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

from caemble_catalog import open_catalog

from app.errors import CaeError


class SolverCatalog:
    """Immutable descriptor/locator snapshot owned by the resident runtime."""

    def __init__(
        self,
        entries: dict[tuple[str, str], dict[str, Any]],
        artifact_types: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self._entries = copy.deepcopy(entries)
        self._artifact_types = copy.deepcopy(artifact_types or {})

    @classmethod
    def discover(cls, catalog_path: Path | None = None) -> SolverCatalog:
        catalog = open_catalog(catalog_path, immutable=True)
        try:
            return cls.from_manifests(
                catalog.solver_manifests(),
                artifact_types=catalog.artifact_types(),
            )
        finally:
            catalog.close()

    @classmethod
    def from_manifests(
        cls,
        manifests: list[dict[str, Any]],
        *args: Any,
        solvers_root: Path | None = None,
        artifact_types: list[dict[str, Any]] | None = None,
    ) -> SolverCatalog:
        del args, solvers_root
        return cls(
            {
                (manifest["descriptor"]["name"], manifest["descriptor"]["version"]): manifest
                for manifest in manifests
            },
            {
                item["name"]: item
                for item in artifact_types or ()
            },
        )

    def manifests(self) -> list[dict[str, Any]]:
        return [copy.deepcopy(self._entries[key]) for key in sorted(self._entries)]

    def entry(self, name: Any, version: Any) -> dict[str, Any]:
        entry = self._entries.get((name, version))
        if entry is None:
            raise CaeError("kernel_not_found", f"CAE kernel {name}@{version} is not registered")
        return copy.deepcopy(entry)

    def descriptor(self, name: Any, version: Any) -> dict[str, Any]:
        return self.entry(name, version)["descriptor"]

    def locator(self, name: Any, version: Any) -> str:
        return self.entry(name, version)["implementation"]

    def abi_version(self, name: Any, version: Any) -> int:
        return int(self.entry(name, version).get("abiVersion", 1))

    def artifact_type(self, name: str) -> dict[str, Any]:
        try:
            return copy.deepcopy(self._artifact_types[name])
        except KeyError as error:
            raise CaeError("artifact_type_not_found", f"Artifact type {name!r} is not registered") from error


solver_catalog = SolverCatalog.discover()
