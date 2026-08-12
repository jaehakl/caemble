from __future__ import annotations

from typing import Any, Awaitable, Callable

import numpy as np

from app.errors import CaeError
from app.solver_framework.models import FiniteVolumeSystem, SolverContext, VoxelDomain
from app.solver_framework.numerics.finite_volume import create_scalar_finite_volume_system, solve_pcg
from app.solver_framework.numerics.voxel import (
    axis_ticks,
    build_voxel_domain,
    dense_field,
    round_like_javascript,
    voxel_index,
)
from app.solver_framework.world import (
    geometry_part,
    grid_shape,
    material_scalar,
    scalar_parameter,
    single_method,
    experiment_scene,
    surface,
    target_group,
)

async def _run_dc(
    config: dict[str, Any],
    state: Any,
    inputs: dict[str, Any],
    world: dict[str, Any],
    progress: Callable[[Any], Awaitable[None]],
    descriptor: dict[str, Any],
) -> dict[str, Any]:
    del state
    if inputs:
        raise CaeError("invalid_input", "dc-current-density does not accept artifact inputs")
    scene = experiment_scene(world)
    grid_rule = single_method(config, "initializations", "dc.voxel-grid")
    group_name = target_group(grid_rule, "geometry")
    part = geometry_part(scene, group_name)
    source_rule = single_method(config, "boundaryConditions", "dc.source-potential")
    reference_rule = single_method(config, "boundaryConditions", "dc.reference-potential")
    source = surface(scene, target_group(source_rule, "surface"), part["id"])
    reference = surface(scene, target_group(reference_rule, "surface"), part["id"])
    shape = grid_shape(grid_rule)
    domain = await build_voxel_domain(
        scene,
        part,
        source,
        reference,
        shape,
        descriptor["referenceLengthUnit"],
        progress,
        "DC conductor",
    )
    conductivity = material_scalar(world, part, descriptor, "electrical.conductivity")
    source_voltage = scalar_parameter(source_rule["parameters"]["voltage"])
    reference_voltage = scalar_parameter(reference_rule["parameters"]["voltage"])
    tolerance = scalar_parameter(config["parameters"]["relativeTolerance"])
    max_iterations = int(scalar_parameter(config["parameters"]["maxIterations"]))
    system = create_scalar_finite_volume_system(domain, source_voltage, reference_voltage)
    solution, iterations, residual = await solve_pcg(system, tolerance, max_iterations, progress, "DC")
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
                active_values = np.empty(solution.size, dtype=np.float64)
                for active, global_index in enumerate(system.active_cells):
                    gradient = _gradient(
                        domain,
                        system,
                        solution,
                        int(global_index),
                        source_voltage,
                        reference_voltage,
                    )
                    active_values[active] = conductivity * float(np.dot(gradient, gradient))
                joule = {
                    "value": dense_field(domain, system, active_values),
                    "axes": [{"ticks": ticks[0]}, {"ticks": ticks[1]}, {"ticks": ticks[2]}],
                }
            artifacts[key] = joule
        elif method in {"dc.current-density", "dc.total-current"}:
            position = scalar_parameter(output["parameters"]["crossSectionPosition"])
            if position not in cross_sections:
                cross_sections[position] = _cross_section(
                    solution,
                    system,
                    domain,
                    position,
                    conductivity,
                    source_voltage,
                    reference_voltage,
                    position in density_positions,
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
        context.progress,
        context.descriptor,
    )


def _cross_section(
    solution: np.ndarray[Any, Any],
    system: FiniteVolumeSystem,
    domain: VoxelDomain,
    position: float,
    conductivity: float,
    source_voltage: float,
    reference_voltage: float,
    include_values: bool,
) -> tuple[np.ndarray[Any, Any], float]:
    shape = domain.shape
    face_index = min(shape[0], max(0, round_like_javascript(position * shape[0])))
    values = np.zeros((shape[2], shape[1]), dtype=np.float64)
    total_density = 0.0
    for row in range(shape[2]):
        k = shape[2] - row - 1
        for j in range(shape[1]):
            current_density = 0.0
            if face_index == 0:
                right_global = voxel_index(0, j, k, shape)
                if domain.occupancy[right_global]:
                    current_density = (
                        2
                        * conductivity
                        * (source_voltage - solution[system.active_index[right_global]])
                        / domain.axial_spacing
                    )
            elif face_index == shape[0]:
                left_global = voxel_index(shape[0] - 1, j, k, shape)
                if domain.occupancy[left_global]:
                    current_density = (
                        2
                        * conductivity
                        * (solution[system.active_index[left_global]] - reference_voltage)
                        / domain.axial_spacing
                    )
            else:
                left_global = voxel_index(face_index - 1, j, k, shape)
                right_global = voxel_index(face_index, j, k, shape)
                if domain.occupancy[left_global] and domain.occupancy[right_global]:
                    current_density = (
                        conductivity
                        * (
                            solution[system.active_index[left_global]]
                            - solution[system.active_index[right_global]]
                        )
                        / domain.axial_spacing
                    )
            if include_values:
                values[row, j] = current_density
            total_density += current_density
    total_current = abs(total_density * domain.u_spacing * domain.v_spacing)
    return values, float(total_current)


def _gradient(
    domain: VoxelDomain,
    system: FiniteVolumeSystem,
    values: np.ndarray[Any, Any],
    global_index: int,
    source_value: float,
    reference_value: float,
) -> np.ndarray[Any, Any]:
    shape = domain.shape
    k = global_index % shape[2]
    j = (global_index // shape[2]) % shape[1]
    i = global_index // (shape[1] * shape[2])
    center = values[system.active_index[global_index]]
    coordinates = (i, j, k)
    spacings = (domain.axial_spacing, domain.u_spacing, domain.v_spacing)
    result = np.zeros(3)
    for axis in range(3):
        minus_coordinates = list(coordinates)
        plus_coordinates = list(coordinates)
        minus_coordinates[axis] -= 1
        plus_coordinates[axis] += 1
        minus = (
            system.active_index[voxel_index(*minus_coordinates, shape)]
            if coordinates[axis] > 0
            else -1
        )
        plus = (
            system.active_index[voxel_index(*plus_coordinates, shape)]
            if coordinates[axis] < shape[axis] - 1
            else -1
        )
        minus_gradient = (
            (center - values[minus]) / spacings[axis]
            if minus >= 0
            else 2 * (center - source_value) / spacings[axis]
            if axis == 0 and coordinates[axis] == 0
            else 0
        )
        plus_gradient = (
            (values[plus] - center) / spacings[axis]
            if plus >= 0
            else 2 * (reference_value - center) / spacings[axis]
            if axis == 0 and coordinates[axis] == shape[axis] - 1
            else 0
        )
        result[axis] = (minus_gradient + plus_gradient) / 2
    return result
