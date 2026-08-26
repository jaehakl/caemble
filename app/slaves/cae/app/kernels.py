from __future__ import annotations

from typing import Any, Awaitable, Callable

from app.solver_framework.geometry import GeometryService
from app.solver_framework.registry import registry
from app.solver_framework.normalization import normalize_task_config


def solver_spec(task: dict[str, Any], task_name: str = "task") -> dict[str, Any]:
    del task_name
    kernel = task["kernel"]
    return registry.descriptor(kernel["name"], kernel["version"])


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
    geometry: GeometryService | None = None,
) -> dict[str, Any]:
    return await registry.run(task, state, inputs, world, progress, geometry or GeometryService())
