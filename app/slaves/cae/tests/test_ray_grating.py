from types import SimpleNamespace

import numpy as np
import pytest

from app.methods.optics import reflect, unit_vector
from app.solvers.ray_tracing.v0_3_0.grating import diffracted_direction
from app.solvers.ray_tracing.v0_3_0.formulation_impl import (
    EVENT_ABSORPTION,
    EVENT_DIFFRACTION,
    EVENT_POWER_CUTOFF,
    Ray,
    _diffract,
)
from app.solvers.ray_tracing.v0_3_0.outputs import PathCollector


@pytest.mark.parametrize('order', [-2, -1, 0, 1, 2])
@pytest.mark.parametrize('wavelength', [450e-9, 550e-9, 650e-9])
def test_grating_obeys_vector_equation(order, wavelength):
    incoming = unit_vector(np.array([-0.3, -0.9, 0.1]))
    normal = np.array([0., 1., 0.])
    groove = np.array([0., 0., -1.])
    spacing = 1e-3 / 600
    outgoing = diffracted_direction(incoming, normal, groove, wavelength, spacing, order)
    expected_x = incoming[0] + order * wavelength / spacing
    if expected_x ** 2 + incoming[2] ** 2 > 1:
        assert outgoing is None
    else:
        assert outgoing is not None
        np.testing.assert_allclose(outgoing[[0, 2]], [expected_x, incoming[2]], atol=1e-14)
        assert outgoing[1] >= 0
        assert np.linalg.norm(outgoing) == pytest.approx(1)
        if order == 0:
            np.testing.assert_allclose(outgoing, reflect(incoming, normal), atol=1e-14)


def test_grating_rotation_covariance_backside_and_evanescent_order():
    incoming = unit_vector(np.array([0.1, -1., 0.2]))
    normal = np.array([0., 1., 0.])
    groove = np.array([0., 0., -1.])
    rotation = np.array([[0., 0., 1.], [1., 0., 0.], [0., 1., 0.]])
    outgoing = diffracted_direction(incoming, normal, groove, 550e-9, 1e-6, 1)
    rotated = diffracted_direction(rotation @ incoming, rotation @ normal, rotation @ groove, 550e-9, 1e-6, 1)
    np.testing.assert_allclose(rotated, rotation @ outgoing, atol=1e-14)
    backside = diffracted_direction(-incoming, normal, groove, 550e-9, 1e-6, 1)
    assert backside[1] < 0
    assert diffracted_direction(incoming, normal, groove, 550e-9, 1e-6, 9) is None


def test_multiple_orders_preserve_medium_and_scale_polarization_without_renormalizing():
    ray = Ray(np.array([0., 1., 0.]), np.array([0., -1., 0.]), np.array([1., 0., 0.]),
              np.array([2., 0.6, 0.8, 0.2]), 550e-9, 2., 0,
              medium_name='glass', medium_root='container', medium_stack=[('container', 'glass')])
    ray.vertices.append(ray.origin.copy())
    hit = SimpleNamespace(normal=np.array([0., 1., 0.]), position=np.zeros(3))
    parameters = {
        'spacing': {'value': 1e-6}, 'grooveDirection': {'value': [0, 0, -1]},
        'orders': {'value': [-1, 0, 1, 9]}, 'efficiencies': {'value': [0.1, 0.1, 0.7, 0.1]},
    }
    collector = PathCollector(100)
    branches = _diffract(ray, hit, parameters, 1.5, 1e-10, 1e-9, collector)
    assert len(branches) == 3
    assert sum(branch.stokes[0] for branch in branches) == pytest.approx(1.8)
    assert len({branch.path_key for branch in branches}) == 3
    np.testing.assert_allclose(ray.stokes, [2, 0.6, 0.8, 0.2])
    for branch, efficiency, order in zip(branches, [0.1, 0.1, 0.7], [-1, 0, 1]):
        np.testing.assert_allclose(branch.stokes, np.array([2, -0.6, -0.8, 0.2]) * efficiency, atol=1e-14)
        assert branch.direction[0] == pytest.approx(order * 550e-9 / 1.5 / 1e-6)
        assert branch.medium_stack == ray.medium_stack
        assert branch.medium_stack is not ray.medium_stack
        assert branch.medium_name == 'glass'
        assert branch.medium_root == 'container'
        assert branch.wavelength == ray.wavelength
        assert branch.interactions == 1
        assert branch.events == [EVENT_DIFFRACTION]
        assert np.dot(branch.basis, branch.direction) == pytest.approx(0, abs=1e-14)
    repeated = _diffract(branches[1], hit, parameters, 1.5, 1e-10, 1e-9, collector)
    assert len(repeated) == 3
    assert all(branch.interactions == 2 for branch in repeated)
    assert sum(branch.stokes[0] for branch in repeated) == pytest.approx(0.18)


@pytest.mark.parametrize('orders,efficiencies,threshold,event', [
    ([9], [1.], 1e-10, EVENT_ABSORPTION),
    ([1], [0.], 1e-10, EVENT_ABSORPTION),
    ([1], [0.1], 0.2, EVENT_POWER_CUTOFF),
])
def test_nonpropagating_zero_efficiency_and_cutoff_finish_paths(orders, efficiencies, threshold, event):
    ray = Ray(np.array([0., 1., 0.]), np.array([0., -1., 0.]), np.array([0., 0., -1.]),
              np.array([1., 0., 0., 0.]), 550e-9, 1., 0)
    ray.vertices.append(ray.origin.copy())
    collector = PathCollector(10)
    branches = _diffract(ray, SimpleNamespace(normal=np.array([0., 1., 0.]), position=np.zeros(3)), {
        'spacing': {'value': 1e-6}, 'grooveDirection': {'value': [0, 0, -1]},
        'orders': {'value': orders}, 'efficiencies': {'value': efficiencies},
    }, 1., threshold, 1e-9, collector)
    assert not branches
    assert collector.paths[0].events[-1] == event
