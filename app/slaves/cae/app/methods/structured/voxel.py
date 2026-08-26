from __future__ import annotations

import asyncio
import math
from typing import TYPE_CHECKING, Any, Awaitable, Callable

import numpy as np

from app.methods.geometry import TriangularMesh
from app.methods.structured.models import VoxelDomain

if TYPE_CHECKING:
    from app.methods.finite_volume.models import FiniteVolumeSystem


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

