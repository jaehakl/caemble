from __future__ import annotations

import asyncio
import math
from typing import Any, Awaitable, Callable

import numpy as np

from app.errors import CaeError
from app.solver_framework.models import FiniteVolumeSystem, VoxelDomain
from app.solver_framework.numerics.voxel import voxel_index

_NEIGHBOR_OFFSETS = ((-1, 0, 0), (1, 0, 0), (0, -1, 0), (0, 1, 0), (0, 0, -1), (0, 0, 1))

def create_scalar_finite_volume_system(
    domain: VoxelDomain,
    source_value: float,
    reference_value: float,
    volume_source: np.ndarray[Any, Any] | None = None,
) -> FiniteVolumeSystem:
    occupancy = domain.occupancy
    shape = domain.shape
    active_cells = np.flatnonzero(occupancy).astype(np.int64)
    active_index = np.full(occupancy.size, -1, dtype=np.int64)
    active_index[active_cells] = np.arange(active_cells.size)
    spacings = (domain.axial_spacing, domain.u_spacing, domain.v_spacing)
    weights = tuple(1 / (spacing * spacing) for spacing in spacings)
    neighbor_weights = np.array([weights[0], weights[0], weights[1], weights[1], weights[2], weights[2]])
    neighbors = np.full((active_cells.size, 6), -1, dtype=np.int64)
    diagonal = np.zeros(active_cells.size)
    right_hand_side = np.zeros(active_cells.size)
    initial = np.zeros(active_cells.size)
    for active, index_value in enumerate(active_cells):
        index = int(index_value)
        k = index % shape[2]
        j = (index // shape[2]) % shape[1]
        i = index // (shape[1] * shape[2])
        initial[active] = source_value + (reference_value - source_value) * ((i + 0.5) / shape[0])
        if volume_source is not None:
            right_hand_side[active] = volume_source[index]
        for slot, (di, dj, dk) in enumerate(_NEIGHBOR_OFFSETS):
            ni, nj, nk = i + di, j + dj, k + dk
            if ni < 0 or ni >= shape[0] or nj < 0 or nj >= shape[1] or nk < 0 or nk >= shape[2]:
                continue
            global_neighbor = voxel_index(ni, nj, nk, shape)
            if not occupancy[global_neighbor]:
                continue
            diagonal[active] += neighbor_weights[slot]
            neighbors[active, slot] = active_index[global_neighbor]
        if i == 0:
            diagonal[active] += 2 * weights[0]
            right_hand_side[active] += 2 * weights[0] * source_value
        if i == shape[0] - 1:
            diagonal[active] += 2 * weights[0]
            right_hand_side[active] += 2 * weights[0] * reference_value
        if not math.isfinite(diagonal[active]) or diagonal[active] <= 0:
            raise CaeError("invalid_geometry", "finite-volume matrix contains an isolated cell")
    return FiniteVolumeSystem(
        active_cells,
        active_index,
        neighbors,
        neighbor_weights,
        diagonal,
        right_hand_side,
        initial,
    )


def _apply_matrix(system: FiniteVolumeSystem, values: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
    result = system.diagonal * values
    for slot in range(6):
        neighbors = system.neighbors[:, slot]
        mask = neighbors >= 0
        result[mask] -= system.neighbor_weights[slot] * values[neighbors[mask]]
    return result


async def solve_pcg(
    system: FiniteVolumeSystem,
    tolerance: float,
    max_iterations: int,
    progress: Callable[[Any], Awaitable[None]],
    label: str,
) -> tuple[np.ndarray[Any, Any], int, float]:
    solution = system.initial.copy()
    residual = system.rhs - _apply_matrix(system, solution)
    preconditioned = residual / system.diagonal
    direction = preconditioned.copy()
    residual_preconditioned = float(np.dot(residual, preconditioned))
    rhs_norm = float(np.linalg.norm(system.rhs)) or 1
    relative_residual = float(np.linalg.norm(residual) / rhs_norm)
    if relative_residual <= tolerance:
        await progress({"stage": "solve", "completed": 0, "total": max_iterations})
        return solution, 0, relative_residual
    for iteration in range(1, max_iterations + 1):
        product = _apply_matrix(system, direction)
        denominator = float(np.dot(direction, product))
        if not math.isfinite(denominator) or denominator <= 0:
            raise CaeError("solver_error", f"{label} finite-volume matrix is not positive definite")
        alpha = residual_preconditioned / denominator
        solution += alpha * direction
        residual -= alpha * product
        relative_residual = float(np.linalg.norm(residual) / rhs_norm)
        if relative_residual <= tolerance:
            await progress({"stage": "solve", "completed": iteration, "total": max_iterations})
            return solution, iteration, relative_residual
        preconditioned = residual / system.diagonal
        next_residual_preconditioned = float(np.dot(residual, preconditioned))
        direction = preconditioned + (next_residual_preconditioned / residual_preconditioned) * direction
        residual_preconditioned = next_residual_preconditioned
        if iteration % 8 == 0:
            await progress({"stage": "solve", "completed": iteration, "total": max_iterations})
            await asyncio.sleep(0)
    raise CaeError(
        "solver_convergence",
        f"{label} solve did not converge within {max_iterations} iterations (relative residual {relative_residual})",
    )
