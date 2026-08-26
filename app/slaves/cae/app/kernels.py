"""Compatibility facade for runtime kernel invocation helpers."""

from app.runtime_kernel.coordinator.kernels import (
    normalize_kernel_tasks,
    resolve_output_specs,
    run_kernel,
    run_kernel_transaction,
    solver_spec,
)

__all__ = [
    "normalize_kernel_tasks",
    "resolve_output_specs",
    "run_kernel",
    "run_kernel_transaction",
    "solver_spec",
]
