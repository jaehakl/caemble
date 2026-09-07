from __future__ import annotations

from typing import Any

import numpy as np

from app.methods.geometry import TriangleProvenance, TriangularMesh


class CubeGeometry:
    async def triangular_mesh(
        self,
        scene: dict[str, Any],
        root_id: str,
        reference_length_unit: str,
        progress: Any = None,
    ) -> TriangularMesh:
        del scene, reference_length_unit
        if progress is not None:
            await progress({"stage": "fixture-geometry", "completed": 1, "total": 1})
        return cube_mesh(root_id)

    async def shell_layer(
        self,
        scene: dict[str, Any],
        root_id: str,
        reference_length_unit: str,
        progress: Any = None,
    ) -> None:
        del scene, root_id, reference_length_unit, progress
        return None


def cube_mesh(root_id: str = "solid") -> TriangularMesh:
    vertices = np.asarray(
        [
            [0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 1.0, 1.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [1.0, 1.0, 1.0],
            [1.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    triangles = np.asarray(
        [
            [0, 2, 1],
            [0, 3, 2],
            [4, 5, 6],
            [4, 6, 7],
            [0, 4, 7],
            [0, 7, 3],
            [1, 2, 6],
            [1, 6, 5],
            [0, 1, 5],
            [0, 5, 4],
            [3, 7, 6],
            [3, 6, 2],
        ],
        dtype=np.int64,
    )
    provenance = tuple(
        TriangleProvenance(root_id, "cube", surface_index)
        for surface_index in range(6)
        for _ in range(2)
    )
    return TriangularMesh(vertices, triangles, provenance)

