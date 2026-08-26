from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import numpy as np

from app.methods.coupling import values_on_structured_grid
from app.methods.finite_volume import FiniteVolumeSystem, create_scalar_finite_volume_system, solve_pcg
from app.methods.structured import VoxelDomain, voxel_index

from .domain_impl import HeatDomain


@dataclass(frozen=True, slots=True)
class HeatSolution:
    setup: HeatDomain
    system: FiniteVolumeSystem
    active_values: np.ndarray[Any, Any]
    iterations: int
    relative_residual: float


async def solve_heat(
    setup: HeatDomain,
    heat_source: Any,
    tolerance: float,
    max_iterations: int,
    progress: Callable[[Any], Awaitable[None]],
) -> HeatSolution:
    volume_source = _volume_source(heat_source, setup.grid, setup.conductivity, setup.domain_ref)
    system = create_scalar_finite_volume_system(
        setup.grid,
        setup.source_temperature,
        setup.reference_temperature,
        volume_source,
    )
    solution, iterations, residual = await solve_pcg(
        system,
        tolerance,
        max_iterations,
        progress,
        "Heat",
    )
    return HeatSolution(setup, system, solution, iterations, residual)


def _volume_source(
    artifact: Any,
    domain: VoxelDomain,
    conductivity: float,
    domain_ref: Mapping[str, Any] | None = None,
) -> np.ndarray[Any, Any]:
    source = np.zeros(domain.occupancy.size)
    if artifact is None:
        return source
    if domain_ref is None:
        raise ValueError("heat coupling requires an explicit target domainRef")
    values = values_on_structured_grid(
        artifact,
        domain_ref,
        quantity_kind="PowerDensity",
        unit="W.m-3",
    )
    for i in range(domain.shape[0]):
        for row in range(domain.shape[2]):
            k = domain.shape[2] - row - 1
            for j in range(domain.shape[1]):
                global_index = voxel_index(i, j, k, domain.shape)
                if domain.occupancy[global_index]:
                    source[global_index] = values[i, row, j] / conductivity
    return source
