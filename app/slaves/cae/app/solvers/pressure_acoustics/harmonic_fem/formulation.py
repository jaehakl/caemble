"""P1 tetrahedral Helmholtz operators in physical SI units."""

import numpy as np
from scipy import sparse

from app.methods.finite_element.integration import integration_points

from .model import AcousticOperators


def prepare_operators(model, cancellation=None):
    if not np.isfinite(model.density) or not np.isfinite(model.sound_speed) or min(model.density, model.sound_speed) <= 0:
        raise ValueError("fluid density and sound speed must be finite and positive")
    stiffness, mass = [], []
    for index, nodes in enumerate(model.cells):
        if cancellation is not None and index % 128 == 0:
            cancellation.raise_if_cancelled()
        K, M = np.zeros((4, 4)), np.zeros((4, 4))
        for N, weight, gradients in integration_points("tet4", model.points[nodes]):
            K += gradients @ gradients.T * weight / model.density
            M += np.outer(N, N) * weight / (model.density * model.sound_speed**2)
        stiffness.append(K)
        mass.append(M)
    rows = np.repeat(model.cells, 4, axis=1).ravel()
    columns = np.tile(model.cells, (1, 4)).ravel()
    shape = (len(model.points), len(model.points))
    return AcousticOperators(
        sparse.coo_matrix((np.asarray(stiffness).ravel(), (rows, columns)), shape=shape).tocsr(),
        sparse.coo_matrix((np.asarray(mass).ravel(), (rows, columns)), shape=shape).tocsr(),
    )
