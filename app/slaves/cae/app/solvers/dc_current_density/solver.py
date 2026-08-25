from __future__ import annotations

from typing import Any, Awaitable, Callable

import numpy as np

from app.errors import CaeError
from app.solver_framework.geometry import GeometryService
from app.solver_framework.models import SolverContext, VoxelDomain
from app.solver_framework.numerics.finite_volume import create_scalar_finite_volume_system, solve_pcg
from app.solver_framework.numerics.voxel import (
    axis_ticks,
    build_electrode_voxel_domain,
    build_voxel_domain,
    dense_voxel_field,
    round_like_javascript,
    voxel_index,
)
from app.solver_framework.world import (
    geometry_part,
    geometry_parts,
    grid_shape,
    material_scalar,
    scalar_parameter,
    experiment_scene,
    surface,
    task_scene,
    target_group,
)

async def _run_dc(
    config: dict[str, Any],
    state: Any,
    inputs: dict[str, Any],
    world: dict[str, Any],
    geometry: GeometryService,
    progress: Callable[[Any], Awaitable[None]],
    descriptor: dict[str, Any],
) -> dict[str, Any]:
    del state
    if inputs:
        raise CaeError("invalid_input", "dc-current-density does not accept artifact inputs")
    scene = experiment_scene(world)
    grid_rules = [item for item in config.get("initializations", []) if item.get("methodId") == "dc.voxel-grid"]
    if len(grid_rules) != 1:
        raise CaeError("invalid_task", "dc.voxel-grid must occur exactly once")
    grid_rule = grid_rules[0]
    group_name = target_group(grid_rule, "geometry")
    parts = geometry_parts(scene, group_name)
    boundary_conditions = config.get("boundaryConditions", [])
    legacy_source = [item for item in boundary_conditions if item.get("methodId") == "dc.source-potential"]
    legacy_reference = [item for item in boundary_conditions if item.get("methodId") == "dc.reference-potential"]
    electrode_source = [
        item for item in boundary_conditions if item.get("methodId") == "dc.source-electrode-potential"
    ]
    electrode_reference = [
        item for item in boundary_conditions if item.get("methodId") == "dc.reference-electrode-potential"
    ]
    legacy_mode = len(legacy_source) == len(legacy_reference) == 1 and not electrode_source and not electrode_reference
    electrode_mode = (
        len(electrode_source) == len(electrode_reference) == 1 and not legacy_source and not legacy_reference
    )
    if not legacy_mode and not electrode_mode:
        raise CaeError(
            "invalid_task",
            "DC boundary conditions require exactly one legacy surface pair or one task electrode geometry pair",
        )
    shape = grid_shape(grid_rule)
    conductivities = [material_scalar(world, part, descriptor, "electrical.conductivity") for part in parts]
    fixed_values: np.ndarray[Any, Any] | None = None
    if legacy_mode:
        if len(parts) != 1:
            raise CaeError("invalid_task", "legacy DC surface boundaries require one conductor part")
        part = geometry_part(scene, group_name)
        source_rule, reference_rule = legacy_source[0], legacy_reference[0]
        source = surface(scene, target_group(source_rule, "surface"), part["id"])
        reference = surface(scene, target_group(reference_rule, "surface"), part["id"])
        mesh = await geometry.triangular_mesh(
            scene,
            part["id"],
            descriptor["referenceLengthUnit"],
            progress,
        )
        domain = await build_voxel_domain(
            mesh,
            source,
            reference,
            shape,
            progress,
            "DC conductor",
        )
    else:
        task = task_scene(world)
        source_rule, reference_rule = electrode_source[0], electrode_reference[0]
        source_parts = geometry_parts(task, target_group(source_rule, "geometry", "task"))
        reference_parts = geometry_parts(task, target_group(reference_rule, "geometry", "task"))
        conductivities.extend(
            material_scalar(world, part, descriptor, "electrical.conductivity", "task")
            for part in source_parts + reference_parts
        )
        electrode_domain = await build_electrode_voxel_domain(
            [
                await geometry.triangular_mesh(
                    scene,
                    part["id"],
                    descriptor["referenceLengthUnit"],
                    progress,
                )
                for part in parts
            ],
            [
                await geometry.triangular_mesh(
                    task,
                    part["id"],
                    descriptor["referenceLengthUnit"],
                    progress,
                )
                for part in source_parts
            ],
            [
                await geometry.triangular_mesh(
                    task,
                    part["id"],
                    descriptor["referenceLengthUnit"],
                    progress,
                )
                for part in reference_parts
            ],
            shape,
            progress,
            "DC conductor",
        )
        domain = electrode_domain.domain
        fixed_values = np.full(domain.occupancy.size, np.nan)
        fixed_values[electrode_domain.source_electrode] = scalar_parameter(source_rule["parameters"]["voltage"])
        fixed_values[electrode_domain.reference_electrode] = scalar_parameter(
            reference_rule["parameters"]["voltage"]
        )
    conductivity = conductivities[0]
    if any(not np.isclose(value, conductivity, rtol=1e-12, atol=0) for value in conductivities[1:]):
        raise CaeError("invalid_material", "DC conductor and electrode conductivity values must match")
    source_voltage = scalar_parameter(source_rule["parameters"]["voltage"])
    reference_voltage = scalar_parameter(reference_rule["parameters"]["voltage"])
    tolerance = scalar_parameter(config["parameters"]["relativeTolerance"])
    max_iterations = int(scalar_parameter(config["parameters"]["maxIterations"]))
    system = create_scalar_finite_volume_system(
        domain,
        source_voltage,
        reference_voltage,
        fixed_values=fixed_values,
    )
    solution, iterations, residual = await solve_pcg(system, tolerance, max_iterations, progress, "DC")
    potential = np.full(domain.occupancy.size, np.nan) if fixed_values is None else fixed_values.copy()
    potential[system.active_cells] = solution
    ticks = axis_ticks(domain)
    outputs = config.get("outputs")
    if not isinstance(outputs, list) or not outputs:
        raise CaeError("invalid_task", "dc-current-density requires outputs")
    artifacts: dict[str, Any] = {}
    cross_sections: dict[float, tuple[np.ndarray[Any, Any], float]] = {}
    density_positions = {
        scalar_parameter(output["parameters"]["crossSectionPosition"])
        for output in outputs
        if output.get("methodId") == "dc.current-density"
    }
    joule: dict[str, Any] | None = None
    for index, output in enumerate(outputs):
        method = output.get("methodId")
        key = output.get("key")
        if not isinstance(key, str):
            raise CaeError("invalid_task", "DC output key must be a string")
        if method == "dc.joule-heating":
            if joule is None:
                voxel_values = np.zeros(domain.occupancy.size, dtype=np.float64)
                for global_index in np.flatnonzero(domain.occupancy):
                    gradient = _gradient(
                        domain,
                        potential,
                        int(global_index),
                        source_voltage,
                        reference_voltage,
                        legacy_mode,
                    )
                    voxel_values[global_index] = conductivity * float(np.dot(gradient, gradient))
                joule = {
                    "value": dense_voxel_field(domain, voxel_values),
                    "axes": [{"ticks": ticks[0]}, {"ticks": ticks[1]}, {"ticks": ticks[2]}],
                }
            artifacts[key] = joule
        elif method in {"dc.current-density", "dc.total-current"}:
            position = scalar_parameter(output["parameters"]["crossSectionPosition"])
            if position not in cross_sections:
                cross_sections[position] = _cross_section(
                    potential,
                    domain,
                    position,
                    conductivity,
                    source_voltage,
                    reference_voltage,
                    position in density_positions,
                    legacy_mode,
                )
            values, total = cross_sections[position]
            if method == "dc.total-current":
                artifacts[key] = {"value": total}
            else:
                artifacts[key] = {
                    "value": values[..., None] * domain.axis,
                    "axes": [{"ticks": ticks[1]}, {"ticks": ticks[2]}],
                }
        else:
            raise CaeError("invalid_task", f"unsupported DC output method: {method}")
        await progress({"stage": "output", "completed": index + 1, "total": len(outputs)})
    return {
        "artifacts": artifacts,
        "observations": {"iterations": iterations, "relativeResidual": residual},
    }


async def run(context: SolverContext) -> dict[str, Any]:
    return await _run_dc(
        context.config,
        context.state,
        context.inputs,
        context.world,
        context.geometry,
        context.progress,
        context.descriptor,
    )


def _cross_section(
    potential: np.ndarray[Any, Any],
    domain: VoxelDomain,
    position: float,
    conductivity: float,
    source_voltage: float,
    reference_voltage: float,
    include_values: bool,
    legacy_terminals: bool,
) -> tuple[np.ndarray[Any, Any], float]:
    shape = domain.shape
    face_index = min(shape[0], max(0, round_like_javascript(position * shape[0])))
    values = np.zeros((shape[2], shape[1]), dtype=np.float64)
    total_density = 0.0
    for row in range(shape[2]):
        k = shape[2] - row - 1
        for j in range(shape[1]):
            current_density = 0.0
            if legacy_terminals and face_index == 0:
                right_global = voxel_index(0, j, k, shape)
                if domain.occupancy[right_global]:
                    current_density = (
                        2
                        * conductivity
                        * (source_voltage - potential[right_global])
                        / domain.axial_spacing
                    )
            elif legacy_terminals and face_index == shape[0]:
                left_global = voxel_index(shape[0] - 1, j, k, shape)
                if domain.occupancy[left_global]:
                    current_density = (
                        2
                        * conductivity
                        * (potential[left_global] - reference_voltage)
                        / domain.axial_spacing
                    )
            elif 0 < face_index < shape[0]:
                left_global = voxel_index(face_index - 1, j, k, shape)
                right_global = voxel_index(face_index, j, k, shape)
                if domain.occupancy[left_global] and domain.occupancy[right_global]:
                    current_density = (
                        conductivity
                        * (potential[left_global] - potential[right_global])
                        / domain.axial_spacing
                    )
            if include_values:
                values[row, j] = current_density
            total_density += current_density
    total_current = abs(total_density * domain.u_spacing * domain.v_spacing)
    return values, float(total_current)


def _gradient(
    domain: VoxelDomain,
    values: np.ndarray[Any, Any],
    global_index: int,
    source_value: float,
    reference_value: float,
    legacy_terminals: bool,
) -> np.ndarray[Any, Any]:
    shape = domain.shape
    k = global_index % shape[2]
    j = (global_index // shape[2]) % shape[1]
    i = global_index // (shape[1] * shape[2])
    center = values[global_index]
    coordinates = (i, j, k)
    spacings = (domain.axial_spacing, domain.u_spacing, domain.v_spacing)
    result = np.zeros(3)
    for axis in range(3):
        minus_coordinates = list(coordinates)
        plus_coordinates = list(coordinates)
        minus_coordinates[axis] -= 1
        plus_coordinates[axis] += 1
        minus_global = voxel_index(*minus_coordinates, shape) if coordinates[axis] > 0 else -1
        plus_global = voxel_index(*plus_coordinates, shape) if coordinates[axis] < shape[axis] - 1 else -1
        minus = minus_global if minus_global >= 0 and domain.occupancy[minus_global] else -1
        plus = plus_global if plus_global >= 0 and domain.occupancy[plus_global] else -1
        minus_gradient = (
            (center - values[minus]) / spacings[axis]
            if minus >= 0
            else 2 * (center - source_value) / spacings[axis]
            if legacy_terminals and axis == 0 and coordinates[axis] == 0
            else 0
        )
        plus_gradient = (
            (values[plus] - center) / spacings[axis]
            if plus >= 0
            else 2 * (reference_value - center) / spacings[axis]
            if legacy_terminals and axis == 0 and coordinates[axis] == shape[axis] - 1
            else 0
        )
        result[axis] = (minus_gradient + plus_gradient) / 2
    return result
