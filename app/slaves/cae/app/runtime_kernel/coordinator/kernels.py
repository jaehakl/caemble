from __future__ import annotations

from typing import Any, Awaitable, Callable

from app.runtime_kernel.api import (
    SolverInvocation,
    SolverResourceServices,
    SolverResult,
)
from app.runtime_kernel.compat.legacy import adapt_legacy_result
from app.runtime_kernel.catalog import solver_catalog
from app.runtime_kernel.catalog.normalization import normalize_task_config
from app.runtime_kernel.coordinator.plan import TaskSpec, detached
from app.runtime_kernel.execution import (
    CancellationSignal,
    SolverExecutionTransaction,
    SpawnSolverExecutor,
)

_executor = SpawnSolverExecutor()


def solver_spec(task: dict[str, Any], task_name: str = "task") -> dict[str, Any]:
    del task_name
    kernel = task["kernel"]
    return solver_catalog.descriptor(kernel["name"], kernel["version"])


def resolve_output_specs(task: dict[str, Any], task_name: str) -> dict[str, Any]:
    return normalize_task_config(
        solver_spec(task, task_name),
        task.get("config"),
        task_name,
    )[1]


def normalize_kernel_tasks(tasks: dict[str, Any]) -> dict[str, Any]:
    normalized = {}
    for task_name, task in tasks.items():
        descriptor = solver_spec(task, task_name)
        config, _outputs = normalize_task_config(
            descriptor,
            task["config"],
            task_name,
        )
        normalized[task_name] = {
            "kernel": dict(task["kernel"]),
            "config": config,
        }
    return normalized


async def run_kernel(
    task: dict[str, Any],
    state: Any,
    inputs: dict[str, Any],
    world: dict[str, Any],
    progress: Callable[[Any], Awaitable[None]],
    geometry: Any = None,
    *,
    task_name: str | None = None,
    cancellation: CancellationSignal | None = None,
    timeout: float | None = None,
    executor: SpawnSolverExecutor | None = None,
    resources: SolverResourceServices | None = None,
) -> SolverResult:
    transaction = await run_kernel_transaction(
        task,
        state,
        inputs,
        world,
        progress,
        geometry,
        task_name=task_name,
        cancellation=cancellation,
        timeout=timeout,
        executor=executor,
        resources=resources,
    )
    transaction.commit()
    return transaction.value


async def run_kernel_transaction(
    task: dict[str, Any],
    state: Any,
    inputs: dict[str, Any],
    world: dict[str, Any],
    progress: Callable[[Any], Awaitable[None]],
    geometry: Any = None,
    *,
    task_name: str | None = None,
    cancellation: CancellationSignal | None = None,
    timeout: float | None = None,
    executor: SpawnSolverExecutor | None = None,
    resources: SolverResourceServices | None = None,
    task_spec: TaskSpec | None = None,
) -> SolverExecutionTransaction[SolverResult]:
    del geometry
    kernel = task["kernel"]
    name, version = kernel["name"], kernel["version"]
    invocation = SolverInvocation(
        config=task["config"],
        state=state,
        inputs=inputs,
        world=world,
        geometry=None,
        progress=None,
        descriptor=(detached(task_spec.descriptor) if task_spec is not None else solver_catalog.descriptor(name, version)),
        materials=world.get("materials", {}),
        resources=resources or SolverResourceServices(),
        task_name=task_name,
    )
    transaction = await (executor or _executor).execute_transaction(
        task_spec.locator if task_spec is not None else solver_catalog.locator(name, version),
        invocation,
        progress=progress,
        cancellation=cancellation,
        timeout=timeout,
        abi_version=(task_spec.abi_version if task_spec is not None else solver_catalog.abi_version(name, version)),
    )
    try:
        result = transaction.value
        normalized = (
            result if isinstance(result, SolverResult) else adapt_legacy_result(result, state)
        )
    except BaseException:
        transaction.rollback()
        raise
    return transaction.with_value(normalized)
