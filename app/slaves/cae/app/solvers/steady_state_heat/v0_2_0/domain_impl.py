from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from app.methods.structured import VoxelDomain, build_voxel_domain, structured_grid_ref
from app.runtime_kernel.api import SolverInvocation
from app.runtime_kernel.api.world import (
    experiment_scene,
    geometry_part,
    grid_shape,
    material_property_value,
    scalar_parameter,
    single_method,
    surface,
    target_group,
)


@dataclass(frozen=True, slots=True)
class HeatDomain:
    grid: VoxelDomain
    domain_ref: dict[str, Any]
    conductivity: float
    source_temperature: float
    reference_temperature: float


async def build_heat_domain(context: SolverInvocation) -> HeatDomain:
    config = context.config
    scene = experiment_scene(context.world)
    grid_rule = single_method(config, "initializations", "heat.voxel-grid")
    group_name = target_group(grid_rule, "geometry")
    part = geometry_part(scene, group_name)
    boundaries = [
        rule for rule in config["boundaryConditions"] if rule["methodId"] == "heat.fixed-temperature"
    ]
    source = surface(scene, target_group(boundaries[0], "surface"), part["id"])
    reference = surface(scene, target_group(boundaries[1], "surface"), part["id"])
    mesh = await context.geometry.triangular_mesh(
        scene,
        part["id"],
        context.descriptor["referenceLengthUnit"],
        context.progress,
    )
    domain = await build_voxel_domain(
        mesh,
        source,
        reference,
        grid_shape(grid_rule),
        context.progress,
        "Heat domain",
    )
    return HeatDomain(
        domain,
        structured_grid_ref(
            domain,
            geometry_hashes=[scene["geometryHash"]],
            root_ids=[part["id"]],
            reference_length_unit=context.descriptor["referenceLengthUnit"],
        ),
        float(np.trace(material_property_value(context.world, part, context.descriptor, "thermal.conductivity").reshape(3, 3)) / 3),
        scalar_parameter(boundaries[0]["parameters"]["temperature"]),
        scalar_parameter(boundaries[1]["parameters"]["temperature"]),
    )
