from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from importlib import import_module
from typing import Any, Protocol, TypeAlias

from app.runtime_kernel.api.services import GeometryService
from app.runtime_kernel.api.state import StatePatch

ProgressReporter: TypeAlias = Callable[[Any], Awaitable[None]]
WorldView: TypeAlias = Mapping[str, Any]
MaterialView: TypeAlias = Mapping[str, Any]


class CancellationToken(Protocol):
    @property
    def cancelled(self) -> bool: ...

    def raise_if_cancelled(self) -> None: ...


@dataclass(frozen=True, slots=True)
class InputArtifact:
    """Typed, detached artifact presented at an ABI-v2 input port."""

    artifact_id: str
    artifact_type: str
    producer_task: str
    solver_name: str
    solver_version: str
    output_name: str
    state_revision: int
    data: Mapping[str, Any] | None
    value: Any


@dataclass(frozen=True, slots=True)
class SolverResourceServices:
    """Invocation-local resource locations owned by the runtime kernel."""

    geometry_cache_path: str | None = None
    workspace_path: str | None = None


@dataclass(frozen=True, slots=True)
class SolverInvocation:
    config: Mapping[str, Any]
    state: Mapping[Any, Any]
    inputs: Mapping[str, Any]
    world: WorldView
    geometry: GeometryService | None
    progress: ProgressReporter | None
    descriptor: Mapping[str, Any]
    materials: MaterialView = field(default_factory=dict)
    cancellation: CancellationToken | None = None
    resources: SolverResourceServices = field(default_factory=SolverResourceServices)
    task_name: str | None = None


@dataclass(frozen=True, slots=True)
class SolverResult:
    state_patch: StatePatch = field(default_factory=StatePatch)
    artifacts: Mapping[str, Any] = field(default_factory=dict)
    observations: Mapping[str, Any] = field(default_factory=dict)


SolverRunner: TypeAlias = Callable[[SolverInvocation], Awaitable[SolverResult]]


@dataclass(frozen=True, slots=True)
class SolverImplementation:
    abi_version: int
    run: SolverRunner

    def __post_init__(self) -> None:
        if self.abi_version != 2:
            raise ValueError("SolverImplementation only supports ABI version 2")

    async def __call__(self, invocation: SolverInvocation) -> SolverResult:
        return await self.run(invocation)


def __getattr__(name: str) -> Any:
    """Preserve explicit legacy imports from the former combined models module."""
    if name not in {"LegacySolverAdapter", "adapt_legacy_result"}:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module("app.runtime_kernel.compat.legacy"), name)
    globals()[name] = value
    return value
