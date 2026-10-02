"""Linear buckling about an elastic preload."""

import numpy as np
from scipy import linalg
from scipy.sparse.linalg import ArpackNoConvergence, eigsh

from ..constraints import constraint_transform
from ..operators.geometric import geometric_matrix


def buckling_analysis(model, stiffness, displacement, prepared, count):
    T = constraint_transform(model, np.tile(np.eye(3), (len(model.points), 1, 1)))
    K = (T.T @ stiffness @ T).tocsr()
    G = (T.T @ geometric_matrix(model, displacement, prepared) @ T).tocsr()
    size = K.shape[0]
    if size == 0 or count < 1:
        raise ValueError("buckling analysis requires free degrees of freedom and a positive mode count")
    if size <= 128 or count >= size - 1:
        dense_K, dense_G = K.toarray(), G.toarray()
        # -G는 양정일 필요가 없다. modal용 SPD eigensolver에 억지로 넣지 않는다.
        raw, vectors = linalg.eig(dense_K, -dense_G)
        usable = np.flatnonzero(np.isfinite(raw) & (np.abs(raw.imag) < 1e-8 * np.maximum(1, np.abs(raw.real))) & (raw.real > 0))
        selected = usable[np.argsort(raw[usable].real)][:count]
        values, vectors = raw[selected].real, vectors[:, selected].real
    else:
        requested = min(size - 1, max(count + 4, 2 * count))
        try:
            # -G phi = mu K phi, lambda = 1/mu.  K is the positive
            # constrained elastic metric, so eigsh accepts the indefinite G.
            reciprocals, vectors = eigsh(-G, k=requested, M=K, which="LA", tol=1e-10)
        except (ArpackNoConvergence, RuntimeError, ValueError) as error:
            raise ValueError("sparse buckling eigensolve failed; check supports and preload") from error
        usable = np.flatnonzero(np.isfinite(reciprocals) & (reciprocals > 0))
        selected = usable[np.argsort(1 / reciprocals[usable])][:count]
        values, vectors = 1 / reciprocals[selected], vectors[:, selected]
    if len(values) < count:
        raise ValueError("preload has fewer positive finite buckling factors than requested")
    for value, vector in zip(values, vectors.T):
        if np.linalg.norm(K @ vector + value * G @ vector) / max(np.linalg.norm(K @ vector), 1e-30) > 1e-8:
            raise ValueError("buckling eigenpair did not meet the 1e-8 residual criterion")
    modes = np.asarray(T @ vectors).T.reshape(len(values), len(model.points), 6)
    return {"factors": values, "modes": modes}
