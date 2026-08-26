from __future__ import annotations

import asyncio
import math
from typing import Any, Awaitable, Callable

import numpy as np

from app.solver_framework.geometry import TriangularMesh
from app.solver_framework.models import ElectrodeVoxelDomain, FiniteVolumeSystem, VoxelDomain


async def build_voxel_domain(
    mesh: TriangularMesh,
    source_surface: dict[str, Any],
    reference_surface: dict[str, Any],
    shape: tuple[int, int, int],
    progress: Callable[[Any], Awaitable[None]],
    label: str,
) -> VoxelDomain:
    positions = mesh.vertices
    triangles = positions[mesh.triangles]
    source = _surface_plane(source_surface, mesh, label)
    reference = _surface_plane(reference_surface, mesh, label)
    displacement = reference["center"] - source["center"]
    length = float(np.linalg.norm(displacement))
    axis = displacement / length
    projected_y = np.array([0.0, 1.0, 0.0]) - axis * float(np.dot([0.0, 1.0, 0.0], axis))
    projected_z = np.array([0.0, 0.0, 1.0]) - axis * float(np.dot([0.0, 0.0, 1.0], axis))
    u_axis = projected_y if np.linalg.norm(projected_y) > 1e-8 else projected_z
    u_axis = u_axis / np.linalg.norm(u_axis)
    v_axis = np.cross(axis, u_axis)
    v_axis = v_axis / np.linalg.norm(v_axis)
    origin = (source["center"] + reference["center"]) / 2
    offsets = positions - origin
    u_values = offsets @ u_axis
    v_values = offsets @ v_axis
    minimum_u, maximum_u = float(np.min(u_values)), float(np.max(u_values))
    minimum_v, maximum_v = float(np.min(v_values)), float(np.max(v_values))
    axial_spacing = length / shape[0]
    u_spacing = (maximum_u - minimum_u) / shape[1]
    v_spacing = (maximum_v - minimum_v) / shape[2]
    occupancy = np.zeros(math.prod(shape), dtype=np.uint8)
    occupied = 0
    for i in range(shape[0]):
        s = -length / 2 + (i + 0.5) * axial_spacing
        for j in range(shape[1]):
            u = minimum_u + (j + 0.5) * u_spacing
            for k in range(shape[2]):
                v = minimum_v + (k + 0.5) * v_spacing
                index = voxel_index(i, j, k, shape)
                point = origin + axis * s + u_axis * u + v_axis * v
                if _contains(point, triangles):
                    occupancy[index] = 1
                    occupied += 1
                if (index + 1) % 4096 == 0:
                    await progress({"stage": "occupancy", "completed": index + 1, "total": occupancy.size})
                    await asyncio.sleep(0)
    await progress({"stage": "occupancy", "completed": occupancy.size, "total": occupancy.size})
    return VoxelDomain(
        shape,
        axis,
        length,
        minimum_u,
        minimum_v,
        axial_spacing,
        u_spacing,
        v_spacing,
        occupancy,
        occupied,
    )


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


def _mesh_bounds_center(
    meshes: list[TriangularMesh],
) -> np.ndarray[Any, Any]:
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
    weight_one[valid] = (delta_u[valid] * edge_two[valid, 2] - delta_v[valid] * edge_two[valid, 1]) / denominator[valid]
    weight_two[valid] = (edge_one[valid, 1] * delta_v[valid] - edge_one[valid, 2] * delta_u[valid]) / denominator[valid]
    valid &= (weight_one >= -1e-10) & (weight_two >= -1e-10) & (weight_one + weight_two <= 1 + 1e-10)
    hits = first[valid, 0] + weight_one[valid] * edge_one[valid, 0] + weight_two[valid] * edge_two[valid, 0]
    if hits.size < 2:
        return np.empty(0)
    hits.sort()
    keep = np.concatenate(([True], np.diff(hits) > 1e-10))
    return hits[keep]


def _surface_plane(surface: dict[str, Any], mesh: TriangularMesh, label: str) -> dict[str, Any]:
    del label
    indices = mesh.triangle_indices(surface)
    triangles = mesh.vertices[mesh.triangles[indices]]
    first = triangles[0]
    normal = np.cross(first[1] - first[0], first[2] - first[0])
    normal_length = float(np.linalg.norm(normal))
    normal /= normal_length
    weighted = np.zeros(3)
    total_area = 0.0
    for triangle in triangles:
        anchor, second, third = triangle
        area = float(np.linalg.norm(np.cross(second - anchor, third - anchor)) / 2)
        weighted += ((anchor + second + third) / 3) * area
        total_area += area
    center = weighted / total_area
    return {"center": center, "normal": normal}


def _contains(point: np.ndarray[Any, Any], triangles: np.ndarray[Any, Any]) -> bool:
    direction = np.array([1.0, 0.3713906763541037, 0.5291502622129182])
    direction /= np.linalg.norm(direction)
    hits: list[float] = []
    for triangle in triangles:
        edge1 = triangle[1] - triangle[0]
        edge2 = triangle[2] - triangle[0]
        pvec = np.cross(direction, edge2)
        determinant = float(np.dot(edge1, pvec))
        if abs(determinant) < 1e-12:
            continue
        inverse = 1 / determinant
        tvec = point - triangle[0]
        u = float(np.dot(tvec, pvec) * inverse)
        if u < -1e-10 or u > 1 + 1e-10:
            continue
        qvec = np.cross(tvec, edge1)
        v = float(np.dot(direction, qvec) * inverse)
        if v < -1e-10 or u + v > 1 + 1e-10:
            continue
        distance = float(np.dot(edge2, qvec) * inverse)
        if distance > 1e-10 and all(abs(distance - previous) > 1e-8 for previous in hits):
            hits.append(distance)
    return len(hits) % 2 == 1


def axis_ticks(domain: VoxelDomain) -> tuple[list[float], list[float], list[float]]:
    shape = domain.shape
    axial = [
        -domain.length / 2 + (index + 0.5) * domain.axial_spacing
        for index in range(shape[0])
    ]
    u = [
        domain.minimum_u + (index + 0.5) * domain.u_spacing
        for index in range(shape[1])
    ]
    v = [
        domain.minimum_v + (shape[2] - row - 0.5) * domain.v_spacing
        for row in range(shape[2])
    ]
    return axial, v, u


def dense_field(
    domain: VoxelDomain,
    system: FiniteVolumeSystem,
    active_values: np.ndarray[Any, Any],
) -> np.ndarray[Any, Any]:
    shape = domain.shape
    values = np.zeros((shape[0], shape[2], shape[1]), dtype=np.float64)
    for i in range(shape[0]):
        for row in range(shape[2]):
            k = shape[2] - row - 1
            for j in range(shape[1]):
                active = system.active_index[voxel_index(i, j, k, shape)]
                if active >= 0:
                    values[i, row, j] = active_values[active]
    return values


def dense_voxel_field(domain: VoxelDomain, flat_values: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
    shape = domain.shape
    values = np.zeros((shape[0], shape[2], shape[1]), dtype=np.float64)
    for i in range(shape[0]):
        for row in range(shape[2]):
            k = shape[2] - row - 1
            for j in range(shape[1]):
                index = voxel_index(i, j, k, shape)
                if domain.occupancy[index]:
                    values[i, row, j] = flat_values[index]
    return values


def voxel_index(i: int, j: int, k: int, shape: tuple[int, int, int]) -> int:
    return (i * shape[1] + j) * shape[2] + k


def round_like_javascript(value: float) -> int:
    return math.floor(value + 0.5)
