from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass(frozen=True, slots=True)
class FiniteVolumeSystem:
    active_cells: np.ndarray[Any, Any]
    active_index: np.ndarray[Any, Any]
    neighbors: np.ndarray[Any, Any]
    neighbor_weights: np.ndarray[Any, Any]
    diagonal: np.ndarray[Any, Any]
    rhs: np.ndarray[Any, Any]
    initial: np.ndarray[Any, Any]

