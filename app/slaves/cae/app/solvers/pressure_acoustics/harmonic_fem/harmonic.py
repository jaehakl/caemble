"""One frequency sweep; no Catalog, state packaging or other Solver imports."""

import numpy as np

from app.methods.linalg.direct import solve_sparse

from .model import AcousticSolution


async def solve_harmonic(operators, boundaries, frequencies, cancellation=None, progress=None):
    frequencies = np.asarray(frequencies, dtype=float)
    if (frequencies.ndim != 1 or not len(frequencies) or not np.all(np.isfinite(frequencies))
            or np.any(frequencies <= 0) or np.any(np.diff(frequencies) <= 0)):
        raise ValueError("acoustic frequencies must be finite, positive and strictly increasing")
    pressures, residuals, input_power, output_power = [], [], [], []
    for index, frequency in enumerate(frequencies):
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        omega = 2 * np.pi * frequency
        matrix = operators.stiffness - omega**2 * operators.mass + 1j * omega * boundaries.impedance
        load = boundaries.normal_load[:, index]
        rhs = -1j * omega * load
        try:
            pressure = solve_sparse(matrix, rhs)
        except ValueError as error:
            raise ValueError(f"pressure acoustics failed at {frequency:g} Hz: {error}") from error
        pressures.append(pressure)
        residuals.append(float(np.linalg.norm(matrix @ pressure - rhs) / max(np.linalg.norm(rhs), np.finfo(float).tiny)))
        input_power.append(float(-0.5 * np.real(np.vdot(pressure, load))))
        output_power.append(float(0.5 * np.real(np.vdot(pressure, boundaries.impedance @ pressure))))
        if progress is not None:
            await progress({"stage": "acoustic-frequency-response", "completed": index + 1, "total": len(frequencies)})
    return AcousticSolution(frequencies, np.asarray(pressures).T, np.asarray(residuals), np.asarray(input_power), np.asarray(output_power))
