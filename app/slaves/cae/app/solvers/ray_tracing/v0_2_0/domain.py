"""Version-local domain surface backed by the current ray implementation."""

from .domain_impl import (
    THIN_LAYER_LIMIT,
    ThinStack,
    build_collision_scene,
    is_thin,
    selectors,
    surface_sampler,
    surface_triangle_keys,
)

__all__ = [
    "THIN_LAYER_LIMIT",
    "ThinStack",
    "build_collision_scene",
    "is_thin",
    "selectors",
    "surface_sampler",
    "surface_triangle_keys",
]
