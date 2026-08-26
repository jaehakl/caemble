"""Compatibility exports plus the legacy DC electrode voxel adapter."""

from __future__ import annotations

import asyncio
import math
from typing import Any, Awaitable, Callable

import numpy as np

from app.methods.geometry import TriangularMesh
from app.methods.structured import (
    VoxelDomain,
    axis_ticks,
    build_voxel_domain,
    dense_field,
    dense_voxel_field,
    round_like_javascript,
    voxel_index,
)
from app.methods.structured.voxel import _contains, _surface_plane
from app.solver_framework.models import ElectrodeVoxelDomain


async def build_electrode_voxel_domain(
    conductor_meshes: list[TriangularMesh],
    source_meshes: list[TriangularMesh],
    reference_meshes: list[TriangularMesh],
    shape: tuple[int, int, int],
    progress: Callable[[Any], Awaitable[None]],
    label: str,
) -> ElectrodeVoxelDomain:
    source_center = _mesh_bounds_center(source_meshes)
    reference_center = _mesh_bounds_center(reference_meshes)
    displacement = reference_center - source_center
    center_distance = float(np.linalg.norm(displacement))
    axis = displacement / center_distance
    projected_y = np.array([0.0, 1.0, 0.0]) - axis * float(np.dot([0.0, 1.0, 0.0], axis))
    projected_z = np.array([0.0, 0.0, 1.0]) - axis * float(np.dot([0.0, 0.0, 1.0], axis))
    u_axis = projected_y if np.linalg.norm(projected_y) > 1e-8 else projected_z
    u_axis = u_axis / np.linalg.norm(u_axis)
    v_axis = np.cross(axis, u_axis)
    v_axis = v_axis / np.linalg.norm(v_axis)
    provisional_origin = (source_center + reference_center) / 2
    positions = np.concatenate(
        [mesh.vertices for mesh in conductor_meshes + source_meshes + reference_meshes],
        axis=0,
    )
    provisional_offsets = positions - provisional_origin
    axial = provisional_offsets @ axis
    minimum_axial, maximum_axial = float(np.min(axial)), float(np.max(axial))
    length = maximum_axial - minimum_axial
    origin = provisional_origin + axis * ((minimum_axial + maximum_axial) / 2)
    offsets = positions - origin
    u_values = offsets @ u_axis
    v_values = offsets @ v_axis
    minimum_u, maximum_u = float(np.min(u_values)), float(np.max(u_values))
    minimum_v, maximum_v = float(np.min(v_values)), float(np.max(v_values))
    domain = VoxelDomain(
        shape,
        axis,
        length,
        minimum_u,
        minimum_v,
        length / shape[0],
        (maximum_u - minimum_u) / shape[1],
        (maximum_v - minimum_v) / shape[2],
        np.zeros(math.prod(shape), dtype=np.uint8),
        0,
    )
    frame = (origin, axis, u_axis, v_axis)
    conductor = await _voxelize_meshes(conductor_meshes, domain, frame, progress, "conductor")
    source = await _voxelize_meshes(source_meshes, domain, frame, progress, "source electrode")
    reference = await _voxelize_meshes(reference_meshes, domain, frame, progress, "reference electrode")
    occupancy = (conductor | source | reference).astype(np.uint8)
    occupied = int(np.count_nonzero(occupancy))
    combined = VoxelDomain(
        shape,
        axis,
        length,
        minimum_u,
        minimum_v,
        domain.axial_spacing,
        domain.u_spacing,
        domain.v_spacing,
        occupancy,
        occupied,
    )
    return ElectrodeVoxelDomain(combined, conductor, source, reference)


def _mesh_bounds_center(meshes: list[TriangularMesh]) -> np.ndarray[Any, Any]:
    positions = np.concatenate([mesh.vertices for mesh in meshes], axis=0)
    return (np.min(positions, axis=0) + np.max(positions, axis=0)) / 2


async def _voxelize_meshes(
    meshes: list[TriangularMesh],
    domain: VoxelDomain,
    frame: tuple[np.ndarray[Any, Any], np.ndarray[Any, Any], np.ndarray[Any, Any], np.ndarray[Any, Any]],
    progress: Callable[[Any], Awaitable[None]],
    stage: str,
) -> np.ndarray[Any, Any]:
    origin, axis, u_axis, v_axis = frame
    result = np.zeros(domain.occupancy.size, dtype=bool)
    s_ticks = np.asarray(axis_ticks(domain)[0])
    total = len(meshes) * domain.shape[1] * domain.shape[2]
    completed = 0
    for mesh in meshes:
        triangles = mesh.vertices[mesh.triangles]
        offsets = triangles - origin
        local = np.stack((offsets @ axis, offsets @ u_axis, offsets @ v_axis), axis=-1)
        for j in range(domain.shape[1]):
            u = domain.minimum_u + (j + 0.5) * domain.u_spacing
            for k in range(domain.shape[2]):
                v = domain.minimum_v + (k + 0.5) * domain.v_spacing
                intersections = _column_intersections(local, u, v)
                if intersections.size:
                    counts = intersections.size - np.searchsorted(intersections, s_ticks, side="right")
                    inside = counts % 2 == 1
                    for i in np.flatnonzero(inside):
                        result[voxel_index(int(i), j, k, domain.shape)] = True
                completed += 1
            if completed % 64 == 0:
                await progress({"stage": f"occupancy:{stage}", "completed": completed, "total": total})
                await asyncio.sleep(0)
    await progress({"stage": f"occupancy:{stage}", "completed": total, "total": total})
    return result


def _column_intersections(triangles: np.ndarray[Any, Any], u: float, v: float) -> np.ndarray[Any, Any]:
    first = triangles[:, 0]
    edge_one = triangles[:, 1] - first
    edge_two = triangles[:, 2] - first
    denominator = edge_one[:, 1] * edge_two[:, 2] - edge_one[:, 2] * edge_two[:, 1]
    valid = np.abs(denominator) > 1e-14
    delta_u = u - first[:, 1]
    delta_v = v - first[:, 2]
    weight_one = np.zeros(denominator.size)
    weight_two = np.zeros(denominator.size)
    weight_one[valid] = (
        delta_u[valid] * edge_two[valid, 2] - delta_v[valid] * edge_two[valid, 1]
    ) / denominator[valid]
    weight_two[valid] = (
        edge_one[valid, 1] * delta_v[valid] - edge_one[valid, 2] * delta_u[valid]
    ) / denominator[valid]
    valid &= (
        (weight_one >= -1e-10)
        & (weight_two >= -1e-10)
        & (weight_one + weight_two <= 1 + 1e-10)
    )
    hits = (
        first[valid, 0]
        + weight_one[valid] * edge_one[valid, 0]
        + weight_two[valid] * edge_two[valid, 0]
    )
    if hits.size < 2:
        return np.empty(0)
    hits.sort()
    keep = np.concatenate(([True], np.diff(hits) > 1e-10))
    return hits[keep]


__all__ = [
    "VoxelDomain",
    "axis_ticks",
    "build_electrode_voxel_domain",
    "build_voxel_domain",
    "dense_field",
    "dense_voxel_field",
    "round_like_javascript",
    "voxel_index",
]
