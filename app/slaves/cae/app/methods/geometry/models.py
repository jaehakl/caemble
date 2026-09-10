from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from app.methods.mesh.models import TetrahedralMeshQuality


@dataclass(frozen=True, slots=True)
class TriangleProvenance:
    root_id: str
    source_node_id: str
    surface_index: int


@dataclass(frozen=True, slots=True)
class TriangularMesh:
    vertices: np.ndarray[Any, Any]
    triangles: np.ndarray[Any, Any]
    triangle_provenance: tuple[TriangleProvenance, ...]

    def triangle_indices(self, selector: dict[str, Any]) -> np.ndarray[Any, Any]:
        root_id = selector.get("rootId")
        source_node_id = selector.get("sourceNodeId")
        surface_index = selector.get("surfaceIndex")
        return np.asarray(
            [
                index
                for index, provenance in enumerate(self.triangle_provenance)
                if provenance.root_id == root_id
                and provenance.source_node_id == source_node_id
                and provenance.surface_index == surface_index
            ],
            dtype=np.int64,
        )


@dataclass(frozen=True, slots=True)
class VolumeMesh:
    """Tet4 mesh whose boundary faces point outward from their first provenance alias.

    A bonded interface carries both semantic sides in ``boundary_provenance``.
    Its first alias belongs to the dominant region and follows ``boundary_faces``;
    subsequent aliases observe the reverse winding.
    """

    points: np.ndarray[Any, Any]
    cells: np.ndarray[Any, Any]
    boundary_faces: np.ndarray[Any, Any]
    boundary_provenance: tuple[tuple[TriangleProvenance, ...], ...]
    region_ids: tuple[str, ...]
    cell_region_ids: np.ndarray[Any, Any]
    quality: TetrahedralMeshQuality

    def __post_init__(self) -> None:
        points = np.asarray(self.points, dtype=np.float64)
        cells = np.asarray(self.cells, dtype=np.int64)
        boundary_faces = np.asarray(self.boundary_faces, dtype=np.int64)
        cell_region_ids = np.asarray(self.cell_region_ids, dtype=np.int64).reshape(-1)
        if points.ndim != 2 or points.shape[1] != 3:
            raise ValueError("volume mesh points must have shape (N, 3)")
        if cells.ndim != 2 or cells.shape[1] != 4:
            raise ValueError("volume mesh cells must have shape (M, 4)")
        if boundary_faces.ndim != 2 or boundary_faces.shape[1] != 3:
            raise ValueError("volume mesh boundary faces must have shape (B, 3)")
        if len(self.boundary_provenance) != boundary_faces.shape[0]:
            raise ValueError("each volume mesh boundary face must preserve provenance")
        if any(not aliases for aliases in self.boundary_provenance):
            raise ValueError("boundary provenance aliases cannot be empty")
        if len(set(self.region_ids)) != len(self.region_ids) or not self.region_ids:
            raise ValueError("volume mesh region ids must be non-empty and unique")
        if cell_region_ids.shape != (cells.shape[0],):
            raise ValueError("each volume mesh cell must have one region id")
        if cell_region_ids.size and (
            int(cell_region_ids.min()) < 0 or int(cell_region_ids.max()) >= len(self.region_ids)
        ):
            raise ValueError("volume mesh cell region index is outside the region table")
        for array in (points, cells, boundary_faces, cell_region_ids):
            array.setflags(write=False)
        object.__setattr__(self, "points", points)
        object.__setattr__(self, "cells", cells)
        object.__setattr__(self, "boundary_faces", boundary_faces)
        object.__setattr__(self, "region_ids", tuple(self.region_ids))
        object.__setattr__(self, "cell_region_ids", cell_region_ids)

    @property
    def tetrahedra(self) -> np.ndarray[Any, Any]:
        return self.cells

    def boundary_face_indices(self, selector: dict[str, Any]) -> np.ndarray[Any, Any]:
        root_id = selector.get("rootId")
        source_node_id = selector.get("sourceNodeId")
        surface_index = selector.get("surfaceIndex")
        return np.asarray(
            [
                index
                for index, aliases in enumerate(self.boundary_provenance)
                if any(
                    provenance.root_id == root_id
                    and provenance.source_node_id == source_node_id
                    and provenance.surface_index == surface_index
                    for provenance in aliases
                )
            ],
            dtype=np.int64,
        )

    def boundary_node_indices(self, selector: dict[str, Any]) -> np.ndarray[Any, Any]:
        faces = self.boundary_face_indices(selector)
        return np.unique(self.boundary_faces[faces].reshape(-1))

    def region_cell_indices(self, root_id: str) -> np.ndarray[Any, Any]:
        try:
            region_index = self.region_ids.index(root_id)
        except ValueError:
            return np.empty(0, dtype=np.int64)
        return np.flatnonzero(self.cell_region_ids == region_index)


@dataclass(frozen=True, slots=True)
class ShellLayerGeometry:
    root_id: str
    family_id: str
    inner_offset: float
    outer_offset: float
    inner: TriangularMesh
    outer: TriangularMesh
    minimum_thickness: float
    maximum_thickness: float
