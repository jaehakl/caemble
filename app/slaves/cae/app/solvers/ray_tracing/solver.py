"""Catalog-compatible entry facade for the ray-tracing formulation."""

from app.solvers.ray_tracing import formulation as _formulation
from app.solvers.ray_tracing.domain import (
    ThinStack,
    build_collision_scene as _collision_scene,
    is_thin as _is_thin,
    selectors as _selectors,
    surface_sampler as _surface_sampler,
    surface_triangle_keys as _surface_triangle_keys,
)
from app.solvers.ray_tracing.formulation import run
from app.solvers.ray_tracing.outputs import (
    Detector,
    PathCollector,
    build_detectors as _detectors,
)

__all__ = ["run"]


def __getattr__(name: str):
    return getattr(_formulation, name)
