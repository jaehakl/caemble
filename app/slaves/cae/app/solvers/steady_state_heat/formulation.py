from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import numpy as np

from app.methods.coupling import project_structured_scalar_cell_averages
from app.kernel.api import FieldValue, StructuredGridValue
from app.methods.finite_volume import FiniteVolumeSystem, create_scalar_finite_volume_system, solve_pcg
from app.methods.structured import VoxelDomain, voxel_index

from .domain import HeatDomain


@dataclass(frozen=True, slots=True)
class HeatSolution:
    setup: HeatDomain
    system: FiniteVolumeSystem
    active_values: np.ndarray[Any, Any]
    iterations: int
    relative_residual: float


async def solve_heat(
    setup: HeatDomain,
    heat_source: FieldValue | None,
    tolerance: float,
    max_iterations: int,
    progress: Callable[[Any], Awaitable[None]],
) -> HeatSolution:
    volume_source = _volume_source(heat_source, setup.grid, setup.conductivity, setup.field_domain)
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
    artifact: FieldValue | None,
    domain: VoxelDomain,
    conductivity: float,
    field_domain: StructuredGridValue,
) -> np.ndarray[Any, Any]:
    source = np.zeros(domain.occupancy.size)
    if artifact is None:
        return source
    values = project_structured_scalar_cell_averages(
        artifact,
        field_domain,
        source_spacing=artifact.domain.metadata["spacings"],
        target_spacing=field_domain.metadata["spacings"],
    ).values
    for i in range(domain.shape[0]):
        for row in range(domain.shape[2]):
            k = domain.shape[2] - row - 1
            for j in range(domain.shape[1]):
                global_index = voxel_index(i, j, k, domain.shape)
                if domain.occupancy[global_index]:
                    source[global_index] = values[i, row, j] / conductivity
    return source
