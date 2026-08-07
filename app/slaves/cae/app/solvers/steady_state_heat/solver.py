from __future__ import annotations

from typing import Any, Awaitable, Callable

import numpy as np

from app.errors import CaeError
from app.solver_framework.models import SolverContext, VoxelDomain
from app.solver_framework.numerics.finite_volume import create_scalar_finite_volume_system, solve_pcg
from app.solver_framework.numerics.voxel import axis_ticks, build_voxel_domain, dense_field, voxel_index
from app.solver_framework.world import (
    geometry_part,
    grid_shape,
    material_scalar,
    scalar_parameter,
    single_method,
    structure_scene,
    surface,
    target_group,
)

async def _run_heat(
    config: dict[str, Any],
    state: Any,
    inputs: dict[str, Any],
    world: dict[str, Any],
    progress: Callable[[Any], Awaitable[None]],
    descriptor: dict[str, Any],
) -> dict[str, Any]:
    del state
    if any(name != "heatSource" for name in inputs):
        raise CaeError("invalid_input", "steady-state-heat received an undeclared artifact input")
    scene = structure_scene(world)
    grid_rule = single_method(config, "initializations", "heat.voxel-grid")
    group_name = target_group(grid_rule, "geometry")
    part = geometry_part(scene, group_name)
    boundaries = [
        rule
        for rule in config.get("boundaryConditions", [])
        if isinstance(rule, dict) and rule.get("methodId") == "heat.fixed-temperature"
    ]
    if len(boundaries) != 2:
        raise CaeError("invalid_task", "steady-state-heat requires two fixed-temperature boundaries")
    source = surface(scene, target_group(boundaries[0], "surface"), part["id"])
    reference = surface(scene, target_group(boundaries[1], "surface"), part["id"])
    shape = grid_shape(grid_rule)
    domain = await build_voxel_domain(
        scene,
        part,
        source,
        reference,
        shape,
        descriptor["referenceLengthUnit"],
        progress,
        "Heat domain",
    )
    conductivity = material_scalar(world, part, descriptor, "thermal.conductivity")
    source_temperature = scalar_parameter(boundaries[0]["parameters"]["temperature"])
    reference_temperature = scalar_parameter(boundaries[1]["parameters"]["temperature"])
    tolerance = scalar_parameter(config["parameters"]["relativeTolerance"])
    max_iterations = int(scalar_parameter(config["parameters"]["maxIterations"]))
    volume_source = _volume_source(inputs.get("heatSource"), domain, conductivity)
    system = create_scalar_finite_volume_system(domain, source_temperature, reference_temperature, volume_source)
    solution, iterations, residual = await solve_pcg(system, tolerance, max_iterations, progress, "Heat")
    ticks = axis_ticks(domain)
    outputs = config.get("outputs")
    if not isinstance(outputs, list) or not outputs:
        raise CaeError("invalid_task", "steady-state-heat requires outputs")
    artifacts: dict[str, Any] = {}
    temperature: dict[str, Any] | None = None
    maximum: float | None = None
    for index, output in enumerate(outputs):
        method = output.get("methodId")
        key = output.get("key")
        if not isinstance(key, str):
            raise CaeError("invalid_task", "Heat output key must be a string")
        if method == "heat.temperature":
            if temperature is None:
                temperature = {
                    "value": dense_field(domain, system, solution),
                    "axes": [{"ticks": ticks[0]}, {"ticks": ticks[1]}, {"ticks": ticks[2]}],
                }
            artifacts[key] = temperature
        elif method == "heat.maximum-temperature":
            maximum = float(np.max(solution)) if maximum is None else maximum
            artifacts[key] = {"value": maximum}
        else:
            raise CaeError("invalid_task", f"unsupported Heat output method: {method}")
        await progress({"stage": "output", "completed": index + 1, "total": len(outputs)})
    return {
        "artifacts": artifacts,
        "observations": {"iterations": iterations, "relativeResidual": residual},
    }


async def run(context: SolverContext) -> dict[str, Any]:
    return await _run_heat(
        context.config,
        context.state,
        context.inputs,
        context.world,
        context.progress,
        context.descriptor,
    )


def _volume_source(
    artifact: Any,
    domain: VoxelDomain,
    conductivity: float,
) -> np.ndarray[Any, Any]:
    source = np.zeros(domain.occupancy.size)
    if artifact is None:
        return source
    if not isinstance(artifact, dict) or "value" not in artifact:
        raise CaeError("invalid_input", "heatSource must be a three-dimensional tensor artifact")
    values = np.asarray(artifact["value"], dtype=np.float64)
    expected_shape = (domain.shape[0], domain.shape[2], domain.shape[1])
    if values.shape != expected_shape or np.any(~np.isfinite(values)) or np.any(values < 0):
        raise CaeError("invalid_input", "heatSource shape/value does not match heat.voxel-grid")
    expected_ticks = axis_ticks(domain)
    axes = artifact.get("axes")
    if not isinstance(axes, list) or len(axes) != 3:
        raise CaeError("invalid_input", "heatSource must include three voxel axes")
    for axis_index, expected in enumerate(expected_ticks):
        actual = axes[axis_index].get("ticks") if isinstance(axes[axis_index], dict) else None
        if actual is None or not np.allclose(np.asarray(actual, dtype=np.float64), expected, rtol=1e-10, atol=1e-12):
            raise CaeError("invalid_input", f"heatSource axis {axis_index} does not match heat.voxel-grid")
    for i in range(domain.shape[0]):
        for row in range(domain.shape[2]):
            k = domain.shape[2] - row - 1
            for j in range(domain.shape[1]):
                global_index = voxel_index(i, j, k, domain.shape)
                if domain.occupancy[global_index]:
                    source[global_index] = values[i, row, j] / conductivity
    return source
