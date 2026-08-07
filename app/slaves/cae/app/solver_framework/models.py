from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import numpy as np


@dataclass(frozen=True, slots=True)
class SolverContext:
    config: dict[str, Any]
    state: Any
    inputs: dict[str, Any]
    world: dict[str, Any]
    progress: Callable[[Any], Awaitable[None]]
    descriptor: dict[str, Any]


@dataclass(frozen=True, slots=True)
class VoxelDomain:
    shape: tuple[int, int, int]
    axis: np.ndarray[Any, Any]
    length: float
    minimum_u: float
    minimum_v: float
    axial_spacing: float
    u_spacing: float
    v_spacing: float
    occupancy: np.ndarray[Any, Any]
    occupied_count: int


@dataclass(frozen=True, slots=True)
class FiniteVolumeSystem:
    active_cells: np.ndarray[Any, Any]
    active_index: np.ndarray[Any, Any]
    neighbors: np.ndarray[Any, Any]
    neighbor_weights: np.ndarray[Any, Any]
    diagonal: np.ndarray[Any, Any]
    rhs: np.ndarray[Any, Any]
    initial: np.ndarray[Any, Any]
