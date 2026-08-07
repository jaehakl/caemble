from __future__ import annotations

import asyncio
import math
from typing import Any, Awaitable, Callable

import numpy as np

from app.errors import CaeError
from app.solver_framework.models import FiniteVolumeSystem, VoxelDomain
from app.solver_framework.units import convert_ucum_value

_NEIGHBOR_OFFSETS = ((-1, 0, 0), (1, 0, 0), (0, -1, 0), (0, 1, 0), (0, 0, -1), (0, 0, 1))

async def build_voxel_domain(
    scene: dict[str, Any],
    part: dict[str, Any],
    source_surface: dict[str, Any],
    reference_surface: dict[str, Any],
    shape: tuple[int, int, int],
    reference_length_unit: str,
    progress: Callable[[Any], Awaitable[None]],
    label: str,
) -> VoxelDomain:
    positions, polygons = _mesh(
        part,
        _length_scale(scene.get("lengthUnit"), reference_length_unit, label),
    )
    source = _surface_plane(source_surface, polygons, label)
    reference = _surface_plane(reference_surface, polygons, label)
    displacement = reference["center"] - source["center"]
    length = float(np.linalg.norm(displacement))
    if not math.isfinite(length) or length <= 0:
        raise CaeError("invalid_geometry", f"{label} terminal centers must be separated")
    axis = displacement / length
    if (
        float(np.dot(source["normal"], reference["normal"])) > -1 + 1e-7
        or float(np.dot(source["normal"], axis)) > -1 + 1e-7
        or float(np.dot(reference["normal"], axis)) < 1 - 1e-7
    ):
        raise CaeError("invalid_geometry", f"{label} terminals must be parallel, opposite, and normal to their axis")
    projected_y = np.array([0.0, 1.0, 0.0]) - axis * float(np.dot([0.0, 1.0, 0.0], axis))
    projected_z = np.array([0.0, 0.0, 1.0]) - axis * float(np.dot([0.0, 0.0, 1.0], axis))
    u_axis = projected_y if np.linalg.norm(projected_y) > 1e-8 else projected_z
    u_axis = u_axis / np.linalg.norm(u_axis)
    v_axis = np.cross(axis, u_axis)
    v_axis = v_axis / np.linalg.norm(v_axis)
    origin = (source["center"] + reference["center"]) / 2
    offsets = positions - origin
    axial = offsets @ axis
    tolerance = max(length * 1e-8, np.max(np.ptp(positions, axis=0)) * 2e-12, 1e-9)
    if np.any(axial < -length / 2 - tolerance) or np.any(axial > length / 2 + tolerance):
        raise CaeError("invalid_geometry", f"{label} must remain between its terminal planes")
    u_values = offsets @ u_axis
    v_values = offsets @ v_axis
    minimum_u, maximum_u = float(np.min(u_values)), float(np.max(u_values))
    minimum_v, maximum_v = float(np.min(v_values)), float(np.max(v_values))
    if maximum_u <= minimum_u or maximum_v <= minimum_v:
        raise CaeError("invalid_geometry", f"{label} cross-section bounds must be positive")
    axial_spacing = length / shape[0]
    u_spacing = (maximum_u - minimum_u) / shape[1]
    v_spacing = (maximum_v - minimum_v) / shape[2]
    triangles = _triangles(polygons)
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
    if occupied == 0:
        raise CaeError("invalid_geometry", f"{label} did not occupy any cells")
    await progress({"stage": "occupancy", "completed": occupancy.size, "total": occupancy.size})
    await _validate_connectivity(occupancy, occupied, shape, progress, label)
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


def _mesh(part: dict[str, Any], scale: float) -> tuple[np.ndarray[Any, Any], list[np.ndarray[Any, Any]]]:
    geometry = part.get("geometry")
    if not isinstance(geometry, dict) or geometry.get("kind") != "mesh":
        raise CaeError("invalid_geometry", "CAE kernels require a serialized mesh")
    positions = np.asarray(geometry.get("positions"), dtype=np.float64).reshape(-1, 3) * scale
    offsets = np.asarray(geometry.get("polygonOffsets"), dtype=np.int64).reshape(-1)
    if positions.size == 0 or offsets.size < 2 or offsets[0] != 0 or offsets[-1] != positions.shape[0]:
        raise CaeError("invalid_geometry", "serialized mesh offsets are invalid")
    polygons = [positions[offsets[index] : offsets[index + 1]] for index in range(offsets.size - 1)]
    if any(polygon.shape[0] < 3 for polygon in polygons):
        raise CaeError("invalid_geometry", "mesh polygons require at least three vertices")
    return positions, polygons


def _surface_plane(surface: dict[str, Any], polygons: list[np.ndarray[Any, Any]], label: str) -> dict[str, Any]:
    indices = surface.get("polygonIndices")
    if not isinstance(indices, list) or not indices:
        raise CaeError("invalid_geometry", f"{label} terminal has no polygons")
    first = polygons[indices[0]]
    normal = np.cross(first[1] - first[0], first[2] - first[0])
    normal_length = float(np.linalg.norm(normal))
    if normal_length <= 0:
        raise CaeError("invalid_geometry", f"{label} terminal has an invalid normal")
    normal /= normal_length
    weighted = np.zeros(3)
    total_area = 0.0
    points: list[np.ndarray[Any, Any]] = []
    for index in indices:
        try:
            polygon = polygons[index]
        except IndexError as exc:
            raise CaeError("invalid_geometry", f"{label} terminal references a missing polygon") from exc
        points.append(polygon)
        anchor = polygon[0]
        for triangle_index in range(1, polygon.shape[0] - 1):
            second, third = polygon[triangle_index], polygon[triangle_index + 1]
            area = float(np.linalg.norm(np.cross(second - anchor, third - anchor)) / 2)
            weighted += ((anchor + second + third) / 3) * area
            total_area += area
    if total_area <= 0:
        raise CaeError("invalid_geometry", f"{label} terminal has no positive area")
    center = weighted / total_area
    tolerance = 1e-8
    if any(np.any(np.abs((polygon - first[0]) @ normal) > tolerance) for polygon in points):
        raise CaeError("invalid_geometry", f"{label} terminal must be planar")
    return {"center": center, "normal": normal}


def _triangles(polygons: list[np.ndarray[Any, Any]]) -> np.ndarray[Any, Any]:
    result = []
    for polygon in polygons:
        for index in range(1, polygon.shape[0] - 1):
            result.append([polygon[0], polygon[index], polygon[index + 1]])
    return np.asarray(result, dtype=np.float64)


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


async def _validate_connectivity(
    occupancy: np.ndarray[Any, Any],
    occupied_count: int,
    shape: tuple[int, int, int],
    progress: Callable[[Any], Awaitable[None]],
    label: str,
) -> None:
    source_cells = []
    reference_cells = []
    for j in range(shape[1]):
        for k in range(shape[2]):
            source = voxel_index(0, j, k, shape)
            reference = voxel_index(shape[0] - 1, j, k, shape)
            if occupancy[source]:
                source_cells.append(source)
            if occupancy[reference]:
                reference_cells.append(reference)
    if not source_cells or not reference_cells:
        raise CaeError("invalid_geometry", f"{label} must occupy both terminal planes")
    visited = np.zeros(occupancy.size, dtype=np.uint8)
    queue = np.empty(occupied_count, dtype=np.int64)
    queue[0] = source_cells[0]
    visited[source_cells[0]] = 1
    head, tail = 0, 1
    while head < tail:
        index = int(queue[head])
        head += 1
        k = index % shape[2]
        j = (index // shape[2]) % shape[1]
        i = index // (shape[1] * shape[2])
        for di, dj, dk in _NEIGHBOR_OFFSETS:
            ni, nj, nk = i + di, j + dj, k + dk
            if ni < 0 or ni >= shape[0] or nj < 0 or nj >= shape[1] or nk < 0 or nk >= shape[2]:
                continue
            neighbor = voxel_index(ni, nj, nk, shape)
            if not occupancy[neighbor] or visited[neighbor]:
                continue
            visited[neighbor] = 1
            queue[tail] = neighbor
            tail += 1
        if head % 8192 == 0:
            await progress({"stage": "connectivity", "completed": head, "total": occupied_count})
            await asyncio.sleep(0)
    if tail != occupied_count or not any(visited[index] for index in reference_cells):
        raise CaeError("invalid_geometry", f"{label} cells must form one connected domain")
    await progress({"stage": "connectivity", "completed": occupied_count, "total": occupied_count})


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


def voxel_index(i: int, j: int, k: int, shape: tuple[int, int, int]) -> int:
    return (i * shape[1] + j) * shape[2] + k


def round_like_javascript(value: float) -> int:
    return math.floor(value + 0.5)


def _length_scale(unit: Any, reference_unit: str, path: str) -> float:
    if not isinstance(unit, str) or not unit:
        raise CaeError("invalid_unit", f"{path} scene.lengthUnit must be a non-empty UCUM unit")
    return convert_ucum_value(
        1,
        unit,
        reference_unit,
        f"{path} scene.lengthUnit",
    ) - convert_ucum_value(
        0,
        unit,
        reference_unit,
        f"{path} scene.lengthUnit",
    )
