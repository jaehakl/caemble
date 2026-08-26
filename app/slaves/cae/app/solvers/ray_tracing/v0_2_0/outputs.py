"""Version-local output surface, including the ray.paths artifact request."""

from .outputs_impl import (
    DETECTOR_OUTPUT_METHODS,
    PATH_OUTPUT_METHOD,
    Detector,
    PathCollector,
    build_detectors,
    build_ray_outputs,
)

__all__ = [
    "DETECTOR_OUTPUT_METHODS",
    "PATH_OUTPUT_METHOD",
    "Detector",
    "PathCollector",
    "build_detectors",
    "build_ray_outputs",
]
