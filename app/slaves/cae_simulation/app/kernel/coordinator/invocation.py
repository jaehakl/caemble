"""Execute a prepared task in a child and return its provisional result."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from app.kernel.api import SolverInvocation, SolverResourceServices, SolverResult
from app.kernel.coordinator.plan import TaskSpec, detached
from app.kernel.execution import CancellationSignal, SolverExecutionTransaction, SpawnSolverExecutor


async def execute_solver(
    task_spec: TaskSpec,
    state: Mapping[Any, Any],
    inputs: Mapping[str, Any],
    world: Mapping[str, Any],
    progress: Callable[[Any], Awaitable[None]],
    *,
    executor: SpawnSolverExecutor,
    cancellation: CancellationSignal | None = None,
    timeout: float | None = None,
    resources: SolverResourceServices | None = None,
) -> SolverExecutionTransaction[SolverResult]:
    invocation = SolverInvocation(
        config=detached(task_spec.task["config"]),
        state=state,
        inputs=inputs,
        world=world,
        geometry=None,
        progress=None,
        descriptor=detached(task_spec.descriptor),
        materials=world.get("materials", {}),
        resources=resources or SolverResourceServices(),
        task_name=task_spec.name,
    )
    return await executor.execute_transaction(
        task_spec.locator,
        invocation,
        progress=progress,
        cancellation=cancellation,
        timeout=timeout,
        abi_version=task_spec.abi_version,
    )
