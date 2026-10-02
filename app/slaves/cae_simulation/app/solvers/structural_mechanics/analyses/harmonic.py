"""Linear structural frequency response with the exp(+i*omega*t) convention."""

import numpy as np

from ..model import HarmonicSolution
from ..numerics import solve_linear
from ..operators.prepared import PreparedStructuralOperators


async def solve_harmonic(operators: PreparedStructuralOperators, transform, frequencies, force, cancellation=None, progress=None):
    """Solve a sweep from prepared operators, constraints and peak forcing only."""
    frequencies = np.asarray(frequencies, dtype=np.float64)
    if frequencies.ndim != 1 or not frequencies.size or not np.all(np.isfinite(frequencies)) or np.any(frequencies <= 0) or np.any(np.diff(frequencies) <= 0):
        raise ValueError("harmonic frequencies must be finite, positive and strictly increasing")
    K, M, C = (transform.T @ matrix @ transform for matrix in (operators.stiffness, operators.mass, operators.damping))
    rhs = np.asarray(transform.T @ np.asarray(force).ravel(), dtype=np.complex128)
    response, residuals = [], []
    for frequency in frequencies:
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        omega = 2 * np.pi * frequency
        dynamic = K - omega**2 * M + 1j * omega * C
        value = solve_linear(dynamic, rhs)
        residuals.append(np.linalg.norm(dynamic @ value - rhs) / max(np.linalg.norm(rhs), np.finfo(float).tiny))
        response.append(np.asarray(transform @ value).reshape(-1, 6))
        if progress is not None:
            await progress({"stage": "harmonic-frequency", "completed": len(response), "total": len(frequencies)})
    return HarmonicSolution(frequencies, np.asarray(response, dtype=np.complex128), np.asarray(residuals))
