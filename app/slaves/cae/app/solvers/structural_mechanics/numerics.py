"""Add structural problem context to the shared sparse numerical solve."""

import numpy as np
from scipy.sparse.linalg import ArpackNoConvergence, eigsh

from app.methods.linalg.direct import solve_sparse


def solve_linear(matrix, rhs, *, ordering="COLAMD", positive_definite=False, backend="direct",
                 near_nullspace=None, block_size=1, tolerance=1e-8, cancellation=None):
    try:
        return solve_sparse(matrix, rhs, ordering=ordering, positive_definite=positive_definite,
            backend=backend, near_nullspace=near_nullspace, block_size=block_size,
            tolerance=tolerance, cancellation=cancellation)
    except ValueError as error:
        raise ValueError(f"structural solve failed; check supports and active connections: {error}") from error


def _positive_sparse_mass(matrix):
    """Whether a large symmetric mass matrix has no physical nullspace."""
    mass_scale = max(float(abs(matrix).max()), 1.)
    try:
        smallest = float(eigsh(matrix, k=1, which="SA", return_eigenvectors=False, tol=1e-9)[0])
    except (ArpackNoConvergence, RuntimeError, ValueError):
        return False
    return smallest > mass_scale * 1e-12
