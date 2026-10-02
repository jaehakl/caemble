"""Positive tetrahedral quadrature and interior MINI interpolation."""

from functools import lru_cache

import numpy as np
from scipy.special import roots_jacobi


@lru_cache(maxsize=8)
def tetrahedron_quadrature(order=5):
    """Duffy product rule; weights integrate the reference tetrahedron (volume 1/6)."""
    rules = []
    for exponent in (2, 1, 0):
        points, weights = roots_jacobi(order, exponent, 0)
        rules.append(((points + 1) / 2, weights / 2**(exponent + 1)))
    a, b, c = np.meshgrid(*(rule[0] for rule in rules), indexing="ij")
    weights = np.einsum("i,j,k->ijk", *(rule[1] for rule in rules)).ravel()
    barycentric = np.stack(
        ((1-a)*(1-b)*(1-c), a, (1-a)*b, (1-a)*(1-b)*c), axis=-1,
    ).reshape(-1, 4)
    barycentric.flags.writeable = weights.flags.writeable = False
    return barycentric, weights


def mini_shape(barycentric, gradients):
    """Nodal P1 functions plus a unit-centroid bubble and reference gradients."""
    barycentric = np.asarray(barycentric)
    bubble = 256 * np.prod(barycentric, axis=-1)
    derivative = 256 * np.stack([np.prod(barycentric[..., [j for j in range(4) if j != i]], axis=-1) for i in range(4)], axis=-1)
    bubble_gradient = derivative @ gradients
    values = np.concatenate((barycentric, bubble[..., None]), axis=-1)
    expanded = np.broadcast_to(gradients, (*barycentric.shape[:-1], 4, 3))
    return values, np.concatenate((expanded, bubble_gradient[..., None, :]), axis=-2)
