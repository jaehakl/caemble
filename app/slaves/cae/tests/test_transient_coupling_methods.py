"""Spatial flux and time-volume conservation against independent affine integrals."""

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from app.methods.coupling.surface import planar_face_flux_operator
from app.methods.time.integration import integrate_piecewise_linear
from tests.test_harmonic_surface_methods import rectangle


def target_quads(nx=4, ny=3):
    points, _ = rectangle(nx, ny)
    faces = []
    for y in range(ny):
        for x in range(nx):
            node = y * (nx + 1) + x
            faces.append([node, node + 1, node + nx + 2, node + nx + 1])
    return points, np.asarray(faces)


@pytest.mark.parametrize("rotated", [False, True])
def test_each_grid_face_preserves_constant_affine_and_opposing_local_flux(rotated):
    source, triangles = rectangle(3, 2, alternate=True)
    target, quads = target_quads()
    rotation = Rotation.from_rotvec([.3, -.5, .2]).as_matrix() if rotated else np.eye(3)
    translation = np.array([2., -3., 5.])
    normal = rotation[:, 2]
    G = planar_face_flux_operator(source @ rotation.T + translation, triangles[:, ::-1],
                                  target @ rotation.T + translation, quads)
    assert G.shape == (len(quads), len(source) * 3)
    centers, area = target[quads].mean(axis=1), 2 / len(quads)
    for scalar, expected in (
        (np.ones(len(source)), np.ones(len(quads))),
        (2 + 3 * source[:, 0] - source[:, 1], 2 + 3 * centers[:, 0] - centers[:, 1]),
        (source[:, 0] - 1, centers[:, 0] - 1),
    ):
        actual = G @ (scalar[:, None] * normal).ravel()
        np.testing.assert_allclose(actual, expected * area, atol=3e-14, rtol=3e-14)
        np.testing.assert_allclose(actual.sum(), area * expected.sum(), atol=5e-14)
    opposing_flux = G @ ((source[:, 0] - 1)[:, None] * normal).ravel()
    assert np.any(opposing_flux < -.01) and np.any(opposing_flux > .01)
    assert abs(opposing_flux.sum()) < 5e-14
    np.testing.assert_allclose(G @ np.tile(rotation[:, 0], len(source)), 0, atol=2e-15)
    reversed_normal = planar_face_flux_operator(source @ rotation.T + translation, triangles,
                                                target @ rotation.T + translation, quads[:, ::-1])
    np.testing.assert_allclose(reversed_normal.toarray(), -G.toarray(), atol=2e-14)


@pytest.mark.parametrize("fault", ["source-gap", "source-hole", "source-duplicate", "target-duplicate", "target-hole", "curved", "degenerate"])
def test_face_flux_rejects_incomplete_or_overlapping_physical_patches(fault):
    source, triangles = rectangle(3, 2)
    target, quads = target_quads()
    if fault == "source-gap":
        source[:, 2] += .01
    elif fault == "source-hole":
        triangles = triangles[1:]
    elif fault == "source-duplicate":
        triangles = np.concatenate([triangles, triangles[:1]])
    elif fault == "target-duplicate":
        quads = np.concatenate([quads, quads[:1]])
    elif fault == "target-hole":
        quads = quads[1:]
    elif fault == "curved":
        target[0, 2] = .01
    else:
        triangles[0, 1] = triangles[0, 0]
    with pytest.raises(ValueError, match="coplanar|coincident|degenerate"):
        planar_face_flux_operator(source, triangles, target, quads)


def test_piecewise_linear_integral_crosses_knots_and_preserves_volume_under_subdivision():
    # A triangle pulse plus an affine component, independently integrable.
    expected = np.array([[.25, .5, 2.], [-.5, -1., -4.]])
    # Include both support ends so the samples represent this exact triangle.
    times = np.array([0., .125, .375, .625, .75, 1.])
    pulse = np.maximum(0., 1 - abs(times - .375) / .25)
    base = np.stack([pulse, times, 2 * times + 1], axis=-1)
    values = np.stack([base, -2 * base])
    whole = integrate_piecewise_linear(times, values, 0., 1., sample_axis=1)
    np.testing.assert_allclose(whole, expected, atol=1e-15)
    split = [0., .0625, .2, .4, .625, .9, 1.]
    parts = sum(integrate_piecewise_linear(times, values, a, b, sample_axis=1)
                for a, b in zip(split, split[1:]))
    np.testing.assert_allclose(parts, expected, atol=1e-15)
    np.testing.assert_array_equal(integrate_piecewise_linear(times, values, .375, .375, sample_axis=1), np.zeros((2, 3)))


def test_time_average_is_at_half_step_for_linear_velocity():
    times = np.array([0., .3, .7, 1.])
    values = 2 * times - .1
    start, end = .2, .6
    mean = integrate_piecewise_linear(times, values, start, end) / (end - start)
    assert mean == pytest.approx(2 * (start + end) / 2 - .1)
    assert mean != pytest.approx(2 * start - .1)


@pytest.mark.parametrize("times,start,end", [
    ([0.], 0., 0.), ([0., 0.], 0., .1), ([0., 1., .5], 0., .5),
    ([0., np.nan], 0., .1), ([0., 1.], -.01, .5), ([0., 1.], .5, 1.01),
    ([0., 1.], .6, .5), ([0., 1.], 0., np.inf),
])
def test_time_integration_rejects_initial_frames_and_outside_requests(times, start, end):
    with pytest.raises(ValueError, match="waveform"):
        integrate_piecewise_linear(times, np.zeros(len(times)), start, end)
