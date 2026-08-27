from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

import numpy as np

from app.methods.geometry import TriangularMesh


async def rasterize_mesh_cell_centers(
    mesh: TriangularMesh,
    x_ticks: Sequence[float],
    y_ticks: Sequence[float],
    z_ticks: Sequence[float],
    progress: Callable[[Any], Awaitable[None]] | None = None,
) -> np.ndarray[Any, np.dtype[np.bool_]]:
    """Return a ``(z, y, x)`` mask for cell centers contained by a closed mesh."""
    x = np.asarray(x_ticks, dtype=np.float64)
    y = np.asarray(y_ticks, dtype=np.float64)
    z = np.asarray(z_ticks, dtype=np.float64)
    mask = np.zeros((z.size, y.size, x.size), dtype=np.bool_)
    column_count = y.size * z.size
    if not column_count or not x.size or not mesh.triangles.size:
        if progress is not None:
            await progress(
                {
                    "stage": "structured-rasterization",
                    "completed": column_count,
                    "total": column_count,
                }
            )
        return mask

    triangles = np.asarray(mesh.vertices[mesh.triangles], dtype=np.float64)
    anchors = triangles[:, 0]
    edge1 = triangles[:, 1] - anchors
    edge2 = triangles[:, 2] - anchors
    direction = np.asarray([1.0, 0.0, 0.0])
    cross_direction_edge2 = np.cross(direction, edge2)
    determinant = np.einsum("ti,ti->t", edge1, cross_direction_edge2)
    determinant_scale = np.linalg.norm(edge1, axis=1) * np.linalg.norm(edge2, axis=1)
    nonparallel = np.abs(determinant) > (
        np.finfo(np.float64).eps * determinant_scale * 64.0
    )
    inverse = np.zeros_like(determinant)
    inverse[nonparallel] = 1.0 / determinant[nonparallel]

    mesh_extent = float(np.max(np.ptp(mesh.vertices, axis=0)))
    coordinate_scale = max(
        mesh_extent,
        float(np.max(np.abs(mesh.vertices))),
        float(np.max(np.abs(x))),
        float(np.max(np.abs(y))),
        float(np.max(np.abs(z))),
    )
    tolerance = max(
        mesh_extent * 1e-10,
        np.finfo(np.float64).eps * coordinate_scale * 64.0,
    )
    barycentric_tolerance = 1e-10
    origin_x = min(float(np.min(mesh.vertices[:, 0])), float(np.min(x))) - max(
        mesh_extent,
        np.finfo(np.float64).eps * coordinate_scale * 64.0,
    )
    yy, zz = np.meshgrid(y, z)
    columns = np.column_stack(
        (
            np.full(column_count, origin_x),
            yy.reshape(-1),
            zz.reshape(-1),
        )
    )

    batch_size = 4096
    for start in range(0, column_count, batch_size):
        stop = min(start + batch_size, column_count)
        displacement = columns[start:stop, None, :] - anchors[None, :, :]
        u = np.einsum("bti,ti->bt", displacement, cross_direction_edge2) * inverse
        cross_displacement_edge1 = np.cross(displacement, edge1[None, :, :])
        v = cross_displacement_edge1[..., 0] * inverse
        distance = np.einsum("bti,ti->bt", cross_displacement_edge1, edge2) * inverse
        intersections = (
            nonparallel[None, :]
            & (u >= -barycentric_tolerance)
            & (u <= 1.0 + barycentric_tolerance)
            & (v >= -barycentric_tolerance)
            & (u + v <= 1.0 + barycentric_tolerance)
            & (distance >= -tolerance)
        )

        for local_index, hits in enumerate(intersections):
            values = np.sort(origin_x + distance[local_index, hits])
            if values.size:
                values = values[np.concatenate(([True], np.diff(values) > tolerance))]
                inside = (
                    np.count_nonzero(values[:, None] > x[None, :] + tolerance, axis=0) % 2
                    == 1
                )
                column = start + local_index
                mask[column // y.size, column % y.size] = inside

        if progress is not None:
            await progress(
                {"stage": "structured-rasterization", "completed": stop, "total": column_count}
            )
        await asyncio.sleep(0)

    return mask
