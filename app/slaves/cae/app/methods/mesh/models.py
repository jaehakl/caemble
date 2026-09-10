from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

import numpy as np


class EntityKind(StrEnum):
    NODE = "node"
    EDGE = "edge"
    FACE = "face"
    CELL = "cell"


@dataclass(frozen=True, slots=True)
class EntitySet:
    name: str
    kind: EntityKind
    indices: np.ndarray[Any, Any]

    def __post_init__(self) -> None:
        object.__setattr__(self, "indices", np.asarray(self.indices, dtype=np.int64).reshape(-1))


@dataclass(frozen=True, slots=True)
class VolumeMeshingProfile:
    """Numerical controls for a linear tetrahedral volume mesh."""

    max_element_size: float
    boundary_max_element_size: float | None = None
    grading: float = 0.3
    optimization_steps: int = 3
    minimum_quality: float = 0.0

    def __post_init__(self) -> None:
        max_element_size = float(self.max_element_size)
        boundary_max_element_size = (
            max_element_size
            if self.boundary_max_element_size is None
            else float(self.boundary_max_element_size)
        )
        grading = float(self.grading)
        minimum_quality = float(self.minimum_quality)
        if not np.isfinite(max_element_size) or max_element_size <= 0:
            raise ValueError("max_element_size must be a finite positive number")
        if not np.isfinite(boundary_max_element_size) or boundary_max_element_size <= 0:
            raise ValueError("boundary_max_element_size must be a finite positive number")
        if not np.isfinite(grading) or grading <= 0:
            raise ValueError("grading must be a finite positive number")
        if (
            isinstance(self.optimization_steps, bool)
            or not isinstance(self.optimization_steps, int)
            or self.optimization_steps < 0
        ):
            raise ValueError("optimization_steps must be a non-negative integer")
        if not np.isfinite(minimum_quality) or not 0 <= minimum_quality <= 1:
            raise ValueError("minimum_quality must be between zero and one")
        object.__setattr__(self, "max_element_size", max_element_size)
        object.__setattr__(self, "boundary_max_element_size", boundary_max_element_size)
        object.__setattr__(self, "grading", grading)
        object.__setattr__(self, "minimum_quality", minimum_quality)


@dataclass(frozen=True, slots=True)
class TetrahedralMeshQuality:
    cell_volumes: np.ndarray[Any, Any]
    mean_ratios: np.ndarray[Any, Any]

    def __post_init__(self) -> None:
        volumes = np.asarray(self.cell_volumes, dtype=np.float64).reshape(-1)
        ratios = np.asarray(self.mean_ratios, dtype=np.float64).reshape(-1)
        if volumes.shape != ratios.shape:
            raise ValueError("tetrahedral quality arrays must have the same length")
        if volumes.size and (not np.all(np.isfinite(volumes)) or np.any(volumes <= 0)):
            raise ValueError("tetrahedral cell volumes must be finite and positive")
        if ratios.size and (
            not np.all(np.isfinite(ratios)) or np.any(ratios <= 0) or np.any(ratios > 1 + 1e-12)
        ):
            raise ValueError("tetrahedral mean ratios must be finite and in (0, 1]")
        volumes.setflags(write=False)
        ratios.setflags(write=False)
        object.__setattr__(self, "cell_volumes", volumes)
        object.__setattr__(self, "mean_ratios", ratios)

    @property
    def minimum_mean_ratio(self) -> float:
        return float(np.min(self.mean_ratios)) if self.mean_ratios.size else math.nan

    @property
    def maximum_mean_ratio(self) -> float:
        return float(np.max(self.mean_ratios)) if self.mean_ratios.size else math.nan


@dataclass(frozen=True, slots=True)
class TetrahedralMesh:
    points: np.ndarray[Any, Any]
    cells: np.ndarray[Any, Any]
    boundary_faces: np.ndarray[Any, Any]
    boundary_markers: np.ndarray[Any, Any]
    cell_region_ids: np.ndarray[Any, Any]
    quality: TetrahedralMeshQuality

    def __post_init__(self) -> None:
        points = np.asarray(self.points, dtype=np.float64)
        cells = np.asarray(self.cells, dtype=np.int64)
        boundary_faces = np.asarray(self.boundary_faces, dtype=np.int64)
        boundary_markers = np.asarray(self.boundary_markers, dtype=np.int64).reshape(-1)
        cell_region_ids = np.asarray(self.cell_region_ids, dtype=np.int64).reshape(-1)
        if points.ndim != 2 or points.shape[1] != 3:
            raise ValueError("tetrahedral mesh points must have shape (N, 3)")
        if cells.ndim != 2 or cells.shape[1] != 4:
            raise ValueError("tetrahedral mesh cells must have shape (M, 4)")
        if boundary_faces.ndim != 2 or boundary_faces.shape[1] != 3:
            raise ValueError("tetrahedral boundary faces must have shape (B, 3)")
        if boundary_markers.shape != (boundary_faces.shape[0],):
            raise ValueError("each tetrahedral boundary face must have one marker")
        if cell_region_ids.shape != (cells.shape[0],):
            raise ValueError("each tetrahedral cell must have one region id")
        if self.quality.cell_volumes.shape != (cells.shape[0],):
            raise ValueError("each tetrahedral cell must have one quality value")
        if cells.size and (int(cells.min()) < 0 or int(cells.max()) >= points.shape[0]):
            raise ValueError("tetrahedral connectivity references a point outside the mesh")
        if boundary_faces.size and (
            int(boundary_faces.min()) < 0 or int(boundary_faces.max()) >= points.shape[0]
        ):
            raise ValueError("boundary connectivity references a point outside the mesh")
        for array in (points, cells, boundary_faces, boundary_markers, cell_region_ids):
            array.setflags(write=False)
        object.__setattr__(self, "points", points)
        object.__setattr__(self, "cells", cells)
        object.__setattr__(self, "boundary_faces", boundary_faces)
        object.__setattr__(self, "boundary_markers", boundary_markers)
        object.__setattr__(self, "cell_region_ids", cell_region_ids)


@dataclass(frozen=True, slots=True)
class UnstructuredMesh:
    points: np.ndarray[Any, Any]
    cells: np.ndarray[Any, Any]
    cell_type: str = "generic"
    sets: Mapping[str, EntitySet] = field(default_factory=dict)

    def __post_init__(self) -> None:
        points = np.asarray(self.points, dtype=np.float64)
        cells = np.asarray(self.cells, dtype=np.int64)
        if points.ndim != 2 or cells.ndim != 2:
            raise ValueError("mesh points and cells must both be rank-2 arrays")
        if cells.size and (int(cells.min()) < 0 or int(cells.max()) >= points.shape[0]):
            raise ValueError("cell connectivity references a node outside the mesh")
        object.__setattr__(self, "points", points)
        object.__setattr__(self, "cells", cells)

    @property
    def spatial_dimension(self) -> int:
        return int(self.points.shape[1])

    @property
    def node_count(self) -> int:
        return int(self.points.shape[0])

    @property
    def cell_count(self) -> int:
        return int(self.cells.shape[0])

    def cell_coordinates(self) -> np.ndarray[Any, Any]:
        return self.points[self.cells]
