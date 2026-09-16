"""Scaled sparse direct solves with explicit failure and residual checks."""

import warnings

import numpy as np
from scipy import sparse
from scipy.sparse.linalg import MatrixRankWarning, splu, spsolve


def solve_sparse(matrix, rhs, *, ordering="COLAMD", positive_definite=False):
    """Solve without regularizing singular systems or concealing resonances."""
    matrix = sparse.csr_matrix(matrix)
    if matrix.shape[0] == 0:
        return np.empty(0, dtype=np.result_type(matrix.dtype, np.asarray(rhs).dtype))
    diagonal = np.abs(matrix.diagonal())
    row_scale = np.asarray(abs(matrix).max(axis=1).toarray()).ravel()
    if np.any(row_scale == 0):
        raise ValueError("linear system is singular")
    diagonal = np.where(diagonal > row_scale * np.finfo(float).eps, diagonal, row_scale)
    scale = 1 / np.sqrt(diagonal)
    D = sparse.diags(scale)
    with warnings.catch_warnings():
        warnings.simplefilter("error", MatrixRankWarning)
        try:
            scaled = (D @ matrix @ D).tocsc()
            if positive_definite:
                # Only callers that establish positive definiteness may disable
                # numerical row pivoting; it otherwise destroys the sparse
                # symmetric ordering on very thin elasticity meshes.
                factor = splu(scaled, permc_spec=ordering, diag_pivot_thresh=0., options={"SymmetricMode": True})
                if np.any(factor.U.diagonal() <= 0):
                    raise ValueError("linear system is not positive definite")
                value = scale * factor.solve(scale * rhs)
                value += scale * factor.solve(scale * (rhs - matrix @ value))
            else:
                value = scale * spsolve(scaled, scale * rhs, permc_spec=ordering)
        except (MatrixRankWarning, RuntimeError) as error:
            raise ValueError("linear system is singular") from error
    if not np.all(np.isfinite(value)):
        raise ValueError("linear solve produced non-finite values")
    residual = np.linalg.norm(matrix @ value - rhs) / max(np.linalg.norm(rhs), np.finfo(float).tiny)
    if residual > 1e-8 and np.linalg.norm(rhs) > 1e-12:
        raise ValueError(f"linear solve relative residual {residual:g} exceeds 1e-8")
    return value
