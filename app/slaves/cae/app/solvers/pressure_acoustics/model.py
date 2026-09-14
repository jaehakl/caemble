"""Values owned by one pressure-acoustics invocation."""

from dataclasses import dataclass

import numpy as np
from scipy.sparse import csr_matrix


@dataclass(frozen=True)
class AcousticModel:
    points: np.ndarray
    cells: np.ndarray
    boundary_regions: dict
    density: float
    sound_speed: float
    identity: str = "acoustic-domain"
    metadata: dict | None = None


@dataclass(frozen=True)
class AcousticOperators:
    stiffness: csr_matrix
    mass: csr_matrix


@dataclass(frozen=True)
class AcousticBoundaries:
    impedance: csr_matrix
    normal_load: np.ndarray


@dataclass(frozen=True)
class AcousticSolution:
    frequencies: np.ndarray
    pressure: np.ndarray
    relative_residuals: np.ndarray
    input_power: np.ndarray
    output_power: np.ndarray
