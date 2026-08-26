"""Compatibility facade for resident GPStation transport handlers."""

from app.runtime_kernel.transport.handlers import (
    cae_simulation_next,
    cae_simulation_start,
    cae_solver_manifests,
    register_handlers,
)

__all__ = [
    "cae_simulation_next",
    "cae_simulation_start",
    "cae_solver_manifests",
    "register_handlers",
]
