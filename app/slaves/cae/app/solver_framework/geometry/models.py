from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass(frozen=True, slots=True)
class TriangleProvenance:
    root_id: str
    source_node_id: str
    face_key: str


@dataclass(frozen=True, slots=True)
class TriangularMesh:
    vertices: np.ndarray[Any, Any]
    triangles: np.ndarray[Any, Any]
    triangle_provenance: tuple[TriangleProvenance, ...]

    def triangle_indices(self, selector: dict[str, Any]) -> np.ndarray[Any, Any]:
        root_id = selector.get("rootId")
        source_node_id = selector.get("sourceNodeId")
        face_key = selector.get("faceKey")
        return np.asarray(
            [
                index
                for index, provenance in enumerate(self.triangle_provenance)
                if provenance.root_id == root_id
                and provenance.source_node_id == source_node_id
                and provenance.face_key == face_key
            ],
            dtype=np.int64,
        )
