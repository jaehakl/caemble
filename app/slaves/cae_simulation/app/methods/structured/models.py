from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np


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
    origin: np.ndarray[Any, Any] = field(default_factory=lambda: np.zeros(3))
