"""Compatibility facade for solver world/config accessors."""

from app.runtime_kernel.api.world import (
    experiment_scene,
    geometry_part,
    geometry_parts,
    grid_shape,
    material_scalar,
    scalar_parameter,
    single_method,
    surface,
    target_group,
    task_scene,
)

__all__ = [
    "experiment_scene",
    "geometry_part",
    "geometry_parts",
    "grid_shape",
    "material_scalar",
    "scalar_parameter",
    "single_method",
    "surface",
    "target_group",
    "task_scene",
]
