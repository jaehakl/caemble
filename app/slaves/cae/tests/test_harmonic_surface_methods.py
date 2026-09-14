"""Independent polynomial and conservation references for shared numerical tools."""

from itertools import product

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from app.methods.coupling.surface import planar_surface_operator
from app.methods.finite_element.integration import integration_points
from app.methods.geometry.surfaces import select_boundary_region
from app.methods.linalg.direct import solve_sparse


def rectangle(nx, ny, alternate=False):
    points = np.asarray([[x, y, 0.] for y in np.linspace(0, 1, ny + 1) for x in np.linspace(0, 2, nx + 1)])
    faces = []
    for y, x in product(range(ny), range(nx)):
        a = y * (nx + 1) + x
        b, c, d = a + 1, a + nx + 2, a + nx + 1
        faces.extend(([a, b, d], [b, c, d]) if alternate else ([a, b, c], [a, c, d]))
    return points, np.asarray(faces)


def test_tet_and_triangle_quadratic_mass_are_exact_and_full_rank():
    for kind, points, volume, denominator in (
        ("tet4", np.array([[0., 0., 0.], [2., 0., 0.], [0., 3., 0.], [0., 0., 4.]]), 4., 20),
        ("tri3", np.array([[0., 0.], [2., 0.], [0., 3.]]), 3., 12),
    ):
        samples = integration_points(kind, points)
        mass = sum(np.outer(N, N) * weight for N, weight, _ in samples)
        np.testing.assert_allclose(mass, volume / denominator * (np.ones_like(mass) + np.eye(len(points))), rtol=2e-15)
        assert np.linalg.eigvalsh(mass).min() > 0
        np.testing.assert_allclose(sum(weight for _, weight, _ in samples), volume)
        for N, _, gradients in samples:
            np.testing.assert_allclose(N.sum(), 1)
            np.testing.assert_allclose(gradients.sum(axis=0), 0, atol=1e-15)
        with pytest.raises(ValueError, match="inverted or degenerate"):
            integration_points(kind, points[[1, 0, *range(2, len(points))]])


@pytest.mark.parametrize("rotated", [False, True])
def test_nonmatching_surface_exact_constant_linear_tangent_and_complex_work(rotated):
    source, sf = rectangle(3, 2)
    target, tf = rectangle(4, 3, True)
    rotation = Rotation.from_rotvec([.4, -.7, .2]).as_matrix() if rotated else np.eye(3)
    translation = np.array([4., -7., .5])
    source_world, target_world = source @ rotation.T + translation, target @ rotation.T + translation
    normal = rotation[:, 2]
    S = planar_surface_operator(source_world, sf[:, ::-1], target_world, tf)
    # The consistent target mass independently integrates the same affine field.
    from app.solvers.pressure_acoustics.boundaries import boundary_mass
    target_mass = boundary_mass(target_world, tf)
    for scalar in (np.ones(len(source)), 2 + 3 * source[:, 0] - source[:, 1]):
        velocity = scalar[:, None] * normal
        expected = np.ones(len(target)) if np.all(scalar == 1) else 2 + 3 * target[:, 0] - target[:, 1]
        np.testing.assert_allclose(S @ velocity.ravel(), target_mass @ expected, atol=2e-13)
    tangential = np.tile(rotation[:, 0], (len(source), 1))
    np.testing.assert_allclose(S @ tangential.ravel(), 0, atol=2e-14)
    opposing = (source[:, 0] - 1)[:, None] * normal
    load = S @ opposing.ravel()
    assert np.linalg.norm(load) > .05
    assert abs(load.sum()) < 1e-13
    rng = np.random.default_rng(841)
    velocity = rng.normal(size=len(source) * 3) + 1j * rng.normal(size=len(source) * 3)
    pressure = rng.normal(size=len(target)) + 1j * rng.normal(size=len(target))
    np.testing.assert_allclose(np.vdot(velocity, S.T @ pressure), np.vdot(S @ velocity, pressure), atol=1e-13)
    reversed_normal = planar_surface_operator(source_world, sf, target_world, tf[:, ::-1])
    np.testing.assert_allclose(reversed_normal.toarray(), -S.toarray(), atol=1e-13)


@pytest.mark.parametrize("error", ["gap", "partial", "duplicate", "curved", "degenerate"])
def test_surface_rejects_unsupported_geometry(error):
    source, sf = rectangle(2, 2)
    target, tf = rectangle(3, 3, True)
    if error == "gap":
        source[:, 2] += .001
    elif error == "partial":
        source[:, 0] *= .9
    elif error == "duplicate":
        sf = np.concatenate((sf, sf[:1]))
    elif error == "curved":
        source[0, 2] += .01
    else:
        sf[0, 1] = sf[0, 0]
    with pytest.raises(ValueError, match="coplanar|coincident|degenerate"):
        planar_surface_operator(source, sf, target, tf)


def test_bonded_semantic_alias_owns_opposite_outward_winding():
    points = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]])
    first, second = ("experiment", "a", "a", 1), ("experiment", "b", "b", 0)
    region = select_boundary_region(points, np.array([[0, 1, 2]]), [(first, second)], {second})
    np.testing.assert_array_equal(region["faces"], [[0, 2, 1]])
    np.testing.assert_allclose(region["faceNormals"], [[0, 0, -1]])
    np.testing.assert_allclose(region["weights"], [1/3] * 3)


def test_sparse_zero_diagonal_invertible_complex_and_singular_cases():
    matrix = np.array([[0, 1j], [1j, 3.]])
    expected = np.array([2 + 3j, -1j])
    np.testing.assert_allclose(solve_sparse(matrix, matrix @ expected), expected)
    with pytest.raises(ValueError, match="singular"):
        solve_sparse(np.zeros((2, 2)), np.ones(2))
