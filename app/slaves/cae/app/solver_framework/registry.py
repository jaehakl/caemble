from __future__ import annotations

import copy
import importlib
import re
from pathlib import Path
from typing import Any, Awaitable, Callable

from caemble_catalog import open_catalog

from app.errors import CaeError
from app.solver_framework.models import SolverContext

Runner = Callable[[SolverContext], Awaitable[dict[str, Any]]]

_IMPLEMENTATION_PATTERN = re.compile(
    r"^app\.solvers\.([a-z][a-z0-9_]*)(?:\.[a-z][a-z0-9_]*)*:[A-Za-z_][A-Za-z0-9_]*$"
)
_DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_DESCRIPTOR_FIELDS = {
    "name",
    "version",
    "referenceLengthUnit",
    "minimumOutputs",
    "parameters",
    "materials",
    "inputPorts",
    "observations",
    "methods",
}


class SolverRegistry:
    def __init__(
        self,
        entries: dict[tuple[str, str], dict[str, Any]],
        contract_digests: dict[tuple[str, str], str],
    ) -> None:
        self._entries = copy.deepcopy(entries)
        self._contract_digests = dict(contract_digests)
        self._runners: dict[tuple[str, str], Runner] = {}

    @classmethod
    def discover(
        cls,
        catalog_path: Path | None = None,
        solvers_root: Path | None = None,
    ) -> SolverRegistry:
        catalog = open_catalog(catalog_path, immutable=True)
        try:
            manifests = catalog.solver_manifests()
            digests = {
                (manifest["descriptor"]["name"], manifest["descriptor"]["version"]):
                catalog.get_solver_contract_digest(
                    manifest["descriptor"]["name"],
                    manifest["descriptor"]["version"],
                )
                for manifest in manifests
            }
        finally:
            catalog.close()
        return cls.from_manifests(manifests, digests, solvers_root=solvers_root)

    @classmethod
    def from_manifests(
        cls,
        manifests: list[dict[str, Any]],
        contract_digests: dict[tuple[str, str], str],
        *,
        solvers_root: Path | None = None,
    ) -> SolverRegistry:
        root = solvers_root or Path(__file__).resolve().parents[1] / "solvers"
        entries: dict[tuple[str, str], dict[str, Any]] = {}
        for manifest in manifests:
            descriptor, implementation = _validate_manifest(manifest)
            identity = (descriptor["name"], descriptor["version"])
            if identity in entries:
                raise RuntimeError(f"Duplicate CAE kernel identity {identity[0]}@{identity[1]}")
            digest = contract_digests.get(identity)
            if not isinstance(digest, str) or _DIGEST_PATTERN.fullmatch(digest) is None:
                raise RuntimeError(
                    f"Invalid CAE solver contract digest for {identity[0]}@{identity[1]}"
                )
            _validate_implementation_path(root, implementation)
            entries[identity] = manifest
        if not entries:
            raise RuntimeError("No active CAE solver contracts found in the catalog")
        if set(contract_digests) != set(entries):
            raise RuntimeError("CAE solver manifests and contract digests do not match")
        return cls(entries, contract_digests)

    def manifests(self) -> list[dict[str, Any]]:
        return [copy.deepcopy(self._entries[identity]) for identity in sorted(self._entries)]

    def descriptor(self, name: Any, version: Any) -> dict[str, Any]:
        entry = self._entries.get((name, version))
        if entry is None:
            raise CaeError("kernel_not_found", f"CAE kernel {name}@{version} is not registered")
        return entry["descriptor"]

    def contract_digest(self, name: Any, version: Any) -> str:
        digest = self._contract_digests.get((name, version))
        if digest is None:
            raise CaeError("kernel_not_found", f"CAE kernel {name}@{version} is not registered")
        return digest

    def validate_contracts(self, contracts: Any, tasks: Any) -> None:
        if not isinstance(contracts, list):
            raise CaeError("invalid_input", "start.solverContracts must be an array")
        received: dict[tuple[str, str], str] = {}
        for index, contract in enumerate(contracts):
            if (
                not isinstance(contract, dict)
                or set(contract) != {"name", "version", "contractDigest"}
                or not isinstance(contract.get("name"), str)
                or not contract["name"]
                or not isinstance(contract.get("version"), str)
                or not contract["version"]
                or not isinstance(contract.get("contractDigest"), str)
                or _DIGEST_PATTERN.fullmatch(contract["contractDigest"]) is None
            ):
                raise CaeError("invalid_input", f"start.solverContracts[{index}] is invalid")
            identity = (contract["name"], contract["version"])
            if identity in received:
                raise CaeError(
                    "invalid_input",
                    f"start.solverContracts contains duplicate {identity[0]}@{identity[1]}",
                )
            received[identity] = contract["contractDigest"]

        expected = _task_kernel_identities(tasks)
        if set(received) != expected:
            missing = sorted(expected - set(received))
            extra = sorted(set(received) - expected)
            details = []
            if missing:
                details.append("missing " + ", ".join(f"{name}@{version}" for name, version in missing))
            if extra:
                details.append("unexpected " + ", ".join(f"{name}@{version}" for name, version in extra))
            raise CaeError(
                "catalog_mismatch",
                "solverContracts do not match simulation tasks: " + "; ".join(details),
            )
        for identity, received_digest in received.items():
            local_digest = self._contract_digests.get(identity)
            if local_digest is None:
                raise CaeError(
                    "catalog_mismatch",
                    f"CAE catalog has no active solver contract for {identity[0]}@{identity[1]}",
                )
            if received_digest != local_digest:
                raise CaeError(
                    "catalog_mismatch",
                    f"solver contract digest differs for {identity[0]}@{identity[1]}",
                )

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


def _validate_manifest(manifest: Any) -> tuple[dict[str, Any], str]:
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {"schemaVersion", "implementation", "descriptor"}
        or manifest.get("schemaVersion") != 1
        or not isinstance(manifest.get("descriptor"), dict)
        or not _DESCRIPTOR_FIELDS.issubset(manifest["descriptor"])
        or not isinstance(manifest["descriptor"].get("name"), str)
        or not manifest["descriptor"]["name"]
        or not isinstance(manifest["descriptor"].get("version"), str)
        or not manifest["descriptor"]["version"]
        or not isinstance(manifest.get("implementation"), str)
        or _IMPLEMENTATION_PATTERN.fullmatch(manifest["implementation"]) is None
    ):
        raise RuntimeError("Invalid CAE solver manifest reconstructed from catalog")
    return manifest["descriptor"], manifest["implementation"]


def _task_kernel_identities(tasks: Any) -> set[tuple[str, str]]:
    if not isinstance(tasks, dict) or not tasks:
        raise CaeError("invalid_program", "simulation manifest tasks are required")
    identities: set[tuple[str, str]] = set()
    for task_name, task in tasks.items():
        kernel = task.get("kernel") if isinstance(task, dict) else None
        if (
            not isinstance(task_name, str)
            or not task_name.strip()
            or not isinstance(kernel, dict)
            or set(kernel) != {"name", "version"}
            or not isinstance(kernel.get("name"), str)
            or not kernel["name"]
            or not isinstance(kernel.get("version"), str)
            or not kernel["version"]
        ):
            raise CaeError("invalid_program", f"task {task_name!r} kernel identity is invalid")
        identities.add((kernel["name"], kernel["version"]))
    return identities


def _validate_implementation_path(solvers_root: Path, implementation: str) -> None:
    module_name, _ = implementation.split(":", 1)
    module_parts = module_name.split(".")
    implementation_path = solvers_root.joinpath(*module_parts[2:]).with_suffix(".py")
    if not implementation_path.is_file():
        raise RuntimeError(f"CAE solver implementation file is missing: {implementation_path}")


registry = SolverRegistry.discover()
