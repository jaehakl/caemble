"""Compensated residuals and refinement for ill-conditioned real sparse systems.

Dot2 uses error-free products/sums from Ogita, Rump and Oishi (2005),
https://doi.org/10.1137/030601818. The two solution components are retained
until physical quantities have been evaluated; native output is float64.
"""

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class CompensatedSolution:
    values: np.ndarray
    roundoff: np.ndarray
    relative_residual: float


def physical_residual(matrix, values, rhs, roundoff=None):
    """Evaluate rhs - A (values + roundoff) without cancelling leading digits."""
    matrix = matrix.tocsr()
    result = np.empty_like(rhs, dtype=float)
    for start in range(0, len(rhs), 16384):
        stop = min(start + 16384, len(rhs))
        counts = np.diff(matrix.indptr[start:stop + 1])
        leading = -np.asarray(rhs[start:stop], dtype=float).copy()
        error = np.zeros(stop - start)
        for column in range(int(counts.max(initial=0))):
            rows = np.flatnonzero(counts > column)
            indices = matrix.indptr[start:stop][rows] + column
            a = matrix.data[indices]
            b = values[matrix.indices[indices]]
            product = a * b
            split_a, split_b = 134217729. * a, 134217729. * b
            high_a = split_a - (split_a - a)
            high_b = split_b - (split_b - b)
            low_a, low_b = a - high_a, b - high_b
            product_error = low_a * low_b - (((product - high_a * high_b) - low_a * high_b) - high_a * low_b)
            previous = leading[rows]
            total = previous + product
            added = total - previous
            sum_error = (previous - (total - added)) + (product - added)
            error[rows] += sum_error + product_error
            leading[rows] = total
        result[start:stop] = -(leading + error)
    if roundoff is not None:
        result -= matrix @ roundoff
    return result


def refine_compensated(matrix, rhs, solve_correction, *, tolerance):
    """Refine the original equations, retaining the low part of each update."""
    values = np.zeros_like(rhs, dtype=float)
    roundoff = np.zeros_like(values)
    defect = np.asarray(rhs, dtype=float).copy()
    scale = max(np.linalg.norm(rhs), np.finfo(float).tiny)
    for iteration in range(4):
        change = roundoff + solve_correction(defect, iteration)
        total = values + change
        added = total - values
        roundoff = (values - (total - added)) + (change - added)
        values = total
        defect = physical_residual(matrix, values, rhs, roundoff)
        residual = np.linalg.norm(defect) / scale
        if not np.isfinite(residual) or residual <= tolerance:
            break
    if not np.isfinite(residual) or residual > tolerance:
        raise ValueError(f"linear solve did not converge: original relative residual {residual:g}")
    return CompensatedSolution(values, roundoff, float(residual))
