"""Reference interpolation and physical integration, independent of field physics."""

from itertools import product

import numpy as np


def shape_functions(kind, natural):
    """Return nodal N and dN/d(reference coordinate)."""
    natural = np.asarray(natural, dtype=float)
    if kind == "tri3":
        r, s = natural
        return np.array([1-r-s, r, s]), np.array([[-1., -1.], [1., 0.], [0., 1.]])
    if kind == "tet4":
        r, s, t = natural
        return np.array([1-r-s-t, r, s, t]), np.array([
            [-1., -1., -1.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.],
        ])
    if kind == "quad4":
        corners = np.array([[-1., -1.], [1., -1.], [1., 1.], [-1., 1.]])
    elif kind == "hex8":
        corners = np.array([
            [-1., -1., -1.], [1., -1., -1.], [1., 1., -1.], [-1., 1., -1.],
            [-1., -1., 1.], [1., -1., 1.], [1., 1., 1.], [-1., 1., 1.],
        ])
    else:
        raise ValueError(f"unsupported element {kind!r}")
    factors = (1 + corners * natural) / 2
    values = np.prod(factors, axis=1)
    derivatives = np.empty_like(corners)
    for axis in range(corners.shape[1]):
        other_axes = [index for index in range(corners.shape[1]) if index != axis]
        derivatives[:, axis] = corners[:, axis] / 2 * np.prod(factors[:, other_axes], axis=1)
    return values, derivatives


def integration_points(kind, coordinates):
    """Return (N, physical area/volume weight, dN/dx), including exact P1 mass."""
    coordinates = np.asarray(coordinates, dtype=float)
    if kind == "tri3":
        samples = [(np.array(point), 1 / 6) for point in [(1/6, 1/6), (2/3, 1/6), (1/6, 2/3)]]
        dimension, nodes = 2, 3
    elif kind == "tet4":
        a, b = (5 + 3 * np.sqrt(5)) / 20, (5 - np.sqrt(5)) / 20
        samples = [(np.array(point), 1 / 24) for point in [(b, b, b), (a, b, b), (b, a, b), (b, b, a)]]
        dimension, nodes = 3, 4
    elif kind in {"quad4", "hex8"}:
        dimension, nodes = (2, 4) if kind == "quad4" else (3, 8)
        samples = [(np.array(point), 1.) for point in product((-1/np.sqrt(3), 1/np.sqrt(3)), repeat=dimension)]
    else:
        raise ValueError(f"unsupported element {kind!r}")
    if coordinates.shape != (nodes, dimension):
        raise ValueError(f"{kind} coordinates must have shape {(nodes, dimension)}")
    result = []
    for natural, quadrature_weight in samples:
        values, derivatives = shape_functions(kind, natural)
        jacobian = coordinates.T @ derivatives
        determinant = float(np.linalg.det(jacobian))
        if not np.isfinite(determinant) or determinant <= 0:
            raise ValueError(f"{kind} has an inverted or degenerate Jacobian")
        gradients = derivatives @ np.linalg.inv(jacobian)
        result.append((values, quadrature_weight * determinant, gradients))
    return result
