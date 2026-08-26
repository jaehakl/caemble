from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol, TypeAlias

from app.runtime_kernel.resources import ContentKey, StatePatch, StateView

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
    state: StateView | Mapping[Any, Any]
    inputs: Mapping[str, Any]
    world: WorldView
    geometry: Any
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


def adapt_legacy_result(
    result: Mapping[str, Any] | SolverResult,
    input_state: Any,
    *,
    input_state_key: ContentKey | None = None,
) -> SolverResult:
    if isinstance(result, SolverResult):
        return result
    if not isinstance(result, Mapping):
        raise TypeError("legacy solver must return a mapping")

    if "state_patch" in result:
        state_patch = result["state_patch"]
        if not isinstance(state_patch, StatePatch):
            raise TypeError("legacy state_patch must be a StatePatch")
    elif "state" not in result:
        state_patch = StatePatch()
    else:
        state = result["state"]
        if state is None:
            state = {}
        if not isinstance(state, Mapping):
            raise TypeError("legacy solver state must be a mapping")
        unchanged = state is input_state
        if input_state_key is not None:
            unchanged = ContentKey.from_parts("legacy-state", state) == input_state_key
        state_patch = StatePatch() if unchanged else StatePatch().replace(state)

    artifacts = result.get("artifacts", result.get("outputs", {}))
    observations = result.get("observations", {})
    if not isinstance(artifacts, Mapping) or not isinstance(observations, Mapping):
        raise TypeError("legacy solver artifacts and observations must be mappings")
    return SolverResult(state_patch, artifacts, observations)


class LegacySolverAdapter:
    abi_version = 2

    def __init__(
        self,
        runner: Callable[[Any], Any],
        *,
        context_factory: Callable[[SolverInvocation], Any] | None = None,
    ) -> None:
        self._runner = runner
        self._context_factory = context_factory

    async def run(self, invocation: SolverInvocation) -> SolverResult:
        state_key = ContentKey.from_parts("legacy-state", invocation.state)
        context = (
            self._context_factory(invocation)
            if self._context_factory is not None
            else invocation
        )
        result = self._runner(context)
        if inspect.isawaitable(result):
            result = await result
        return adapt_legacy_result(
            result,
            invocation.state,
            input_state_key=state_key,
        )

    async def __call__(self, invocation: SolverInvocation) -> SolverResult:
        return await self.run(invocation)
