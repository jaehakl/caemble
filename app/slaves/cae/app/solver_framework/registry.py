"""Compatibility facade for the runtime-owned solver catalog."""

from app.runtime_kernel.catalog import SolverCatalog, solver_catalog

SolverRegistry = SolverCatalog
registry = solver_catalog

__all__ = ["SolverRegistry", "registry"]
