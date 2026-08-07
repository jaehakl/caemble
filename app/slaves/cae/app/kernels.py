from __future__ import annotations

from typing import Any, Awaitable, Callable

from app.errors import CaeError
from app.solver_framework.registry import registry
from app.solver_framework.validation import normalize_task_config


def solver_spec(task: dict[str, Any], task_name: str = "task") -> dict[str, Any]:
    del task_name
    kernel = task.get("kernel") if isinstance(task, dict) else None
    return registry.descriptor(
        kernel.get("name") if isinstance(kernel, dict) else None,
        kernel.get("version") if isinstance(kernel, dict) else None,
    )


def resolve_output_specs(task: dict[str, Any], task_name: str) -> dict[str, Any]:
    return normalize_task_config(
        solver_spec(task, task_name),
        task.get("config"),
        task_name,
    )[1]


def validate_kernel_tasks(tasks: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for task_name, task in tasks.items():
        if not isinstance(task_name, str) or not task_name.strip():
            raise CaeError("invalid_program", "task names must be non-empty strings")
        if (
            not isinstance(task, dict)
            or set(task) != {"kernel", "config"}
            or not isinstance(task.get("kernel"), dict)
            or set(task["kernel"]) != {"name", "version"}
            or not isinstance(task.get("config"), dict)
        ):
            raise CaeError(
                "invalid_program",
                f"task {task_name} must contain exactly kernel and config",
            )
        descriptor = solver_spec(task, task_name)
        config, _outputs = normalize_task_config(
            descriptor,
            task.get("config"),
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
) -> dict[str, Any]:
    return await registry.run(task, state, inputs, world, progress)
