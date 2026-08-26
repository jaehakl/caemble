from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import numpy as np

from app.methods.finite_volume import FiniteVolumeSystem, create_scalar_finite_volume_system, solve_pcg
from app.methods.structured import VoxelDomain, round_like_javascript, voxel_index

from .domain_impl import DcDomain


@dataclass(frozen=True, slots=True)
class DcSolution:
    setup: DcDomain
    system: FiniteVolumeSystem
    potential: np.ndarray[Any, Any]
    active_values: np.ndarray[Any, Any]
    iterations: int
    relative_residual: float


async def solve_dc(
    setup: DcDomain,
    tolerance: float,
    max_iterations: int,
    progress: Callable[[Any], Awaitable[None]],
) -> DcSolution:
    system = create_scalar_finite_volume_system(
        setup.grid,
        setup.source_voltage,
        setup.reference_voltage,
        fixed_values=setup.fixed_values,
    )
    solution, iterations, residual = await solve_pcg(
        system,
        tolerance,
        max_iterations,
        progress,
        "DC",
    )
    potential = np.full(setup.grid.occupancy.size, np.nan) if setup.fixed_values is None else setup.fixed_values.copy()
    potential[system.active_cells] = solution
    return DcSolution(setup, system, potential, solution, iterations, residual)


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
