from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Awaitable, Callable

import numpy as np

from app.methods.finite_volume.models import FiniteVolumeSystem
from app.methods.structured.models import VoxelDomain

if TYPE_CHECKING:
    from app.solver_framework.geometry import GeometryService


@dataclass(frozen=True, slots=True)
class SolverContext:
    config: dict[str, Any]
    state: Any
    inputs: dict[str, Any]
    world: dict[str, Any]
    geometry: GeometryService
    progress: Callable[[Any], Awaitable[None]]
    descriptor: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ElectrodeVoxelDomain:
    domain: VoxelDomain
    conductor: np.ndarray[Any, Any]
    source_electrode: np.ndarray[Any, Any]
    reference_electrode: np.ndarray[Any, Any]
