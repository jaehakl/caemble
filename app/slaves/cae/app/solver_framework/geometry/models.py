from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np


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
class ShellLayerGeometry:
    root_id: str
    family_id: str
    inner_offset: float
    outer_offset: float
    inner: TriangularMesh
    outer: TriangularMesh
    minimum_thickness: float
    maximum_thickness: float
