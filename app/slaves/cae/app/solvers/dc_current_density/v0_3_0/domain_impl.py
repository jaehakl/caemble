from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import numpy as np

from app.methods.geometry import GeometryService, TriangularMesh
from app.methods.structured import VoxelDomain, axis_ticks, build_voxel_domain, structured_grid_ref, voxel_index
from app.runtime_kernel.api import SolverInvocation
from app.runtime_kernel.api.world import (
    experiment_scene,
    geometry_part,
    geometry_parts,
    grid_shape,
    material_property_value,
    scalar_parameter,
    surface,
    target_group,
    task_scene,
)


@dataclass(frozen=True, slots=True)
class ElectrodeVoxelDomain:
    domain: VoxelDomain
    conductor: np.ndarray[Any, Any]
    source_electrode: np.ndarray[Any, Any]
    reference_electrode: np.ndarray[Any, Any]


@dataclass(frozen=True, slots=True)
class DcDomain:
    grid: VoxelDomain
    domain_ref: dict[str, Any]
    conductivity: float
    source_voltage: float
    reference_voltage: float
    fixed_values: np.ndarray[Any, Any] | None
    legacy_terminals: bool


async def build_dc_domain(context: SolverInvocation) -> DcDomain:
    config = context.config
    world = context.world
    descriptor = context.descriptor
    scene = experiment_scene(world)
    grid_rule = next(item for item in config["initializations"] if item["methodId"] == "dc.voxel-grid")
    group_name = target_group(grid_rule, "geometry")
    parts = geometry_parts(scene, group_name)
    boundary_conditions = config["boundaryConditions"]
    legacy_source = [item for item in boundary_conditions if item["methodId"] == "dc.source-potential"]
    legacy_reference = [item for item in boundary_conditions if item["methodId"] == "dc.reference-potential"]
    electrode_source = [
        item for item in boundary_conditions if item["methodId"] == "dc.source-electrode-potential"
    ]
    electrode_reference = [
        item for item in boundary_conditions if item["methodId"] == "dc.reference-electrode-potential"
    ]
    legacy_mode = len(legacy_source) == len(legacy_reference) == 1 and not electrode_source and not electrode_reference
    shape = grid_shape(grid_rule)
    conductivities = [
        float(np.trace(material_property_value(world, part, descriptor, "electrical.conductivity").reshape(3, 3)) / 3)
        for part in parts
    ]
    fixed_values: np.ndarray[Any, Any] | None = None
    geometry_hashes = [scene["geometryHash"]]
    root_ids = [part["id"] for part in parts]
    if legacy_mode:
        part = geometry_part(scene, group_name)
        source_rule, reference_rule = legacy_source[0], legacy_reference[0]
        source = surface(scene, target_group(source_rule, "surface"), part["id"])
        reference = surface(scene, target_group(reference_rule, "surface"), part["id"])
        mesh = await context.geometry.triangular_mesh(
            scene,
            part["id"],
            descriptor["referenceLengthUnit"],
            context.progress,
        )
        domain = await build_voxel_domain(mesh, source, reference, shape, context.progress, "DC conductor")
    else:
        task = task_scene(world)
        source_rule, reference_rule = electrode_source[0], electrode_reference[0]
        source_parts = geometry_parts(task, target_group(source_rule, "geometry", "task"))
        reference_parts = geometry_parts(task, target_group(reference_rule, "geometry", "task"))
        conductivities.extend(
            float(np.trace(material_property_value(world, part, descriptor, "electrical.conductivity", "task").reshape(3, 3)) / 3)
            for part in source_parts + reference_parts
        )
        electrode_domain = await build_electrode_voxel_domain(
            [
                await context.geometry.triangular_mesh(
                    scene,
                    part["id"],
                    descriptor["referenceLengthUnit"],
                    context.progress,
                )
                for part in parts
            ],
            [
                await context.geometry.triangular_mesh(
                    task,
                    part["id"],
                    descriptor["referenceLengthUnit"],
                    context.progress,
                )
                for part in source_parts
            ],
            [
                await context.geometry.triangular_mesh(
                    task,
                    part["id"],
                    descriptor["referenceLengthUnit"],
                    context.progress,
                )
                for part in reference_parts
            ],
            shape,
            context.progress,
            "DC conductor",
        )
        domain = electrode_domain.domain
        fixed_values = np.full(domain.occupancy.size, np.nan)
        fixed_values[electrode_domain.source_electrode] = scalar_parameter(source_rule["parameters"]["voltage"])
        fixed_values[electrode_domain.reference_electrode] = scalar_parameter(
            reference_rule["parameters"]["voltage"]
        )
        geometry_hashes.append(task["geometryHash"])
        root_ids.extend(part["id"] for part in source_parts + reference_parts)
    source_voltage = scalar_parameter(source_rule["parameters"]["voltage"])
    reference_voltage = scalar_parameter(reference_rule["parameters"]["voltage"])
    return DcDomain(
        domain,
        structured_grid_ref(
            domain,
            geometry_hashes=geometry_hashes,
            root_ids=root_ids,
            reference_length_unit=descriptor["referenceLengthUnit"],
        ),
        conductivities[0],
        source_voltage,
        reference_voltage,
        fixed_values,
        legacy_mode,
    )


async def build_electrode_voxel_domain(
    conductor_meshes: list[TriangularMesh],
    source_meshes: list[TriangularMesh],
    reference_meshes: list[TriangularMesh],
    shape: tuple[int, int, int],
    progress: Callable[[Any], Awaitable[None]],
    label: str,
) -> ElectrodeVoxelDomain:
    del label
    source_positions = np.concatenate([mesh.vertices for mesh in source_meshes], axis=0)
    source_center = (np.min(source_positions, axis=0) + np.max(source_positions, axis=0)) / 2
    reference_positions = np.concatenate([mesh.vertices for mesh in reference_meshes], axis=0)
    reference_center = (
        np.min(reference_positions, axis=0) + np.max(reference_positions, axis=0)
    ) / 2
    displacement = reference_center - source_center
    axis = displacement / float(np.linalg.norm(displacement))
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
    axial = (positions - provisional_origin) @ axis
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
        int(np.count_nonzero(occupancy)),
    )
    return ElectrodeVoxelDomain(combined, conductor, source, reference)


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
    return hits[np.concatenate(([True], np.diff(hits) > 1e-10))]
