"""AMG-preconditioned CG with a residual check in the original physical units."""

import gc
import logging
import numpy as np
from scipy import sparse
from scipy.sparse.linalg import LinearOperator, cg


def solve_amg(matrix, rhs, *, near_nullspace=None, block_size=1, tolerance=1e-8, cancellation=None,
              compensated=False):
    from pyamg import smoothed_aggregation_solver

    matrix = (sparse.bsr_matrix(matrix, blocksize=(block_size, block_size)) if block_size > 1
              else sparse.csr_matrix(matrix))
    rhs = np.asarray(rhs, dtype=float)
    diagonal = matrix.diagonal()
    if np.any(diagonal <= 0) or not np.isfinite(diagonal).all():
        raise ValueError("AMG-CG requires a positive definite matrix")
    if not np.any(rhs):
        if compensated:
            from .compensated import CompensatedSolution
            return CompensatedSolution(np.zeros_like(rhs), np.zeros_like(rhs), 0.)
        return np.zeros_like(rhs)
    if block_size > 1:
        # The block relaxation already solves each node's local stiffness.
        # Retain the physical block operator without a second global matrix;
        # candidate rotations and the acceptance residual use the same units.
        scale, scaled = np.ones(len(rhs)), matrix
    else:
        scale = 1 / np.sqrt(diagonal)
        scaled = (sparse.diags(scale) @ matrix @ sparse.diags(scale)).tocsr()
    candidates = np.ones((len(rhs), 1)) if near_nullspace is None else np.asarray(near_nullspace)
    if candidates.ndim != 2 or candidates.shape[0] != len(rhs) or not np.isfinite(candidates).all():
        raise ValueError("AMG near-nullspace candidates must match the free degrees of freedom")
    candidates = candidates / scale[:, None]
    # Orthonormalizing the few candidates avoids unit-dependent translation/rotation scales.
    candidates, singular, _ = np.linalg.svd(candidates, full_matrices=False)
    candidates = candidates[:, singular > singular[0] * 1e-12]
    if cancellation is not None:
        cancellation.raise_if_cancelled()
    relaxation = "block_gauss_seidel" if block_size > 1 else "gauss_seidel"
    # Filtering weak interpolation entries reduces setup fill for the six
    # elastic modes. It changes only the preconditioner, never the physical K.
    smoothing = ("energy", {"prefilter": {"theta": .1}}) if block_size > 1 else "energy"
    options = dict(symmetry="symmetric", strength=("symmetric", {"theta": .05}),
        smooth=smoothing, presmoother=(relaxation, {"sweep": "symmetric"}),
        postsmoother=(relaxation, {"sweep": "symmetric"}), max_coarse=64)
    hierarchy = None
    try:
        hierarchy = smoothed_aggregation_solver(scaled, B=candidates, **options)
    except MemoryError:
        if block_size == 1:
            raise
        logging.getLogger(__name__).warning(
            "AMG setup exhausted memory; retrying float32 preconditioning with float64 equations")
    if hierarchy is None:
        # Leave the exception scope before retrying so its traceback no longer
        # retains the failed hierarchy's large temporary interpolation arrays.
        gc.collect()
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        hierarchy = smoothed_aggregation_solver(scaled.astype(np.float32),
            B=candidates.astype(np.float32), **options)

    def check_cancelled(value):
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        if not np.isfinite(value).all():
            raise ValueError("AMG-CG produced non-finite values")

    preconditioner = hierarchy.aspreconditioner()
    if hierarchy.levels[0].A.dtype == np.float32:
        single_precision = preconditioner
        preconditioner = LinearOperator(matrix.shape, dtype=np.float64,
            matvec=lambda value: np.asarray(single_precision @ np.asarray(value, dtype=np.float32),
                                            dtype=np.float64))
    if compensated:
        from .compensated import refine_compensated

        def solve_correction(defect, iteration):
            correction, status = cg(scaled, scale * defect, M=preconditioner,
                rtol=min(tolerance * .01, 1e-11) if iteration == 0 else 1e-3,
                atol=0., maxiter=2000, callback=check_cancelled)
            if status < 0:
                raise ValueError(f"AMG-CG breakdown: status {status}")
            return scale * correction

        return refine_compensated(matrix, rhs, solve_correction, tolerance=tolerance)
    value = np.zeros_like(rhs)
    defect = rhs.copy()
    rhs_norm = np.linalg.norm(rhs)
    # The scaled norm can conceal a physical residual in very thin layers.
    # Correct that actual defect with the same operator/preconditioner; the
    # original equation remains the only acceptance criterion.
    for _ in range(4):
        correction, info = cg(scaled, scale * defect, M=preconditioner,
            rtol=min(tolerance * .01, 1e-11), atol=0., maxiter=2000, callback=check_cancelled)
        value += scale * correction
        defect = rhs - matrix @ value
        residual = np.linalg.norm(defect) / rhs_norm
        if not np.isfinite(residual) or residual <= tolerance or info < 0:
            break
    if not np.isfinite(residual) or residual > tolerance or info < 0:
        raise ValueError(f"AMG-CG did not converge: relative residual {residual:g}, status {info}")
    return value
