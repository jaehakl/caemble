from types import SimpleNamespace

import numpy as np
import pytest

from app.methods.optics import reflect, unit_vector
from app.solvers.ray_tracing.grating import diffracted_direction
from app.solvers.ray_tracing.formulation import (
    EVENT_ABSORPTION,
    EVENT_DIFFRACTION,
    EVENT_POWER_CUTOFF,
    Ray,
    _diffract,
)
from app.solvers.ray_tracing.outputs import PathCollector
from app.solvers.ray_tracing.grating import build_gratings
from app.methods.geometry.analytic import AnalyticSolid
from tests.ray_parallel_fixtures import scattering_ray_invocation


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
        'orders': {'value': [-1, 0, 1, 9]}, 'reflectedEfficiencies': {'value': [0.1, 0.1, 0.7, 0.1]}, 'transmittedEfficiencies': {'value': [0, 0, 0, 0]},
    }
    collector = PathCollector(100)
    branches = _diffract(ray, hit, parameters, 1.5, 1e-10, collector, target_index=1., target_stack=[])
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
    repeated = _diffract(branches[1], hit, parameters, 1.5, 1e-10, collector, target_index=1., target_stack=[])
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
        'orders': {'value': orders}, 'reflectedEfficiencies': {'value': efficiencies}, 'transmittedEfficiencies': {'value': [0] * len(orders)},
    }, 1., threshold, collector, target_index=1., target_stack=[])
    assert not branches
    assert collector.paths[0].events[-1] == event


@pytest.mark.parametrize('side', [-1., 1.])
@pytest.mark.parametrize('indices,order,expected_x', [((1., 1.), 1, .9), ((1., 1.5), 1, .6),
                                                    ((1., 1.5), 0, 4 / 15), ((1.5, 1.), 0, .6)])
def test_transmission_direction_in_both_media_and_incident_sides(side, indices, order, expected_x):
    incoming = np.array([.4, side * np.sqrt(.84), 0.])
    normal, groove = np.array([0., 1., 0.]), np.array([0., 0., -1.])
    outgoing = diffracted_direction(incoming, normal, groove, .5e-6, 1e-6, order,
                                   incident_index=indices[0], outgoing_index=indices[1], transmission=True)
    np.testing.assert_allclose(outgoing, [expected_x, side * np.sqrt(1 - expected_x ** 2), 0], atol=1e-14)
    rotation = np.array([[0., 0., 1.], [1., 0., 0.], [0., 1., 0.]])
    rotated = diffracted_direction(rotation @ incoming, rotation @ normal, rotation @ groove, .5e-6, 1e-6, order,
                                  incident_index=indices[0], outgoing_index=indices[1], transmission=True)
    np.testing.assert_allclose(rotated, rotation @ outgoing, atol=1e-14)


def test_transmitted_evanescent_order_and_total_internal_reflection():
    normal, groove = np.array([0., 1., 0.]), np.array([0., 0., -1.])
    for incoming, order in [(np.array([0., -1., 0.]), 3), (np.array([.8, -.6, 0.]), 0)]:
        assert diffracted_direction(incoming, normal, groove, .5e-6, 1e-6, order,
                                   incident_index=1.5, outgoing_index=1., transmission=True) is None


@pytest.mark.parametrize('reflected,transmitted', [(.1, .7), (0., .7), (.1, 0.)])
@pytest.mark.parametrize('entering', [True, False])
def test_absolute_branch_power_and_independent_medium_stacks(reflected, transmitted, entering):
    stack = [] if entering else [('substrate', 'glass')]
    target = [('substrate', 'glass')] if entering else []
    ray = Ray(np.array([0., 1., 0.]), np.array([0., -1. if entering else 1., 0.]), np.array([0., 0., -1.]),
              np.array([2., .6, .8, .2]), .5e-6, 2., 0,
              medium_name=None if entering else 'glass', medium_root=None if entering else 'substrate', medium_stack=stack)
    ray.vertices.append(ray.origin.copy())
    branches = _diffract(ray, SimpleNamespace(normal=np.array([0., 1., 0.]), position=np.zeros(3)), {
        'spacing': {'value': 1e-6}, 'grooveDirection': {'value': [0, 0, -1]},
        'orders': {'value': [1]}, 'reflectedEfficiencies': {'value': [reflected]},
        'transmittedEfficiencies': {'value': [transmitted]},
    }, 1. if entering else 1.5, 1e-10, PathCollector(0), target_index=1.5 if entering else 1., target_stack=target)
    assert sum(branch.stokes[0] for branch in branches) == pytest.approx(2 * (reflected + transmitted))
    assert len({branch.path_key for branch in branches}) == len(branches)
    for branch in branches:
        is_transmitted = branch.direction[1] * ray.direction[1] > 0
        expected_stack = target if is_transmitted else stack
        assert branch.medium_stack == expected_stack
        assert branch.medium_stack is not expected_stack
        assert branch.medium_name == (expected_stack[-1][1] if expected_stack else None)
        assert branch.medium_root == (expected_stack[-1][0] if expected_stack else None)
        np.testing.assert_allclose(branch.stokes, ray.stokes * (transmitted if is_transmitted else reflected), atol=1e-14)
    assert ray.medium_stack == stack


@pytest.fixture
def grating_configuration():
    invocation = scattering_ray_invocation(count=1)
    scene = invocation.world['experiment']
    solids = {root['id']: AnalyticSolid(root) for root in scene['roots']}
    config = {'boundaryConditions': [{'methodId': 'ray.diffraction-grating', 'target': ['experiment.surface.glass'],
        'parameters': {'spacing': {'value': 1e-6}, 'grooveDirection': {'value': [0, 1, 0]},
                       'orders': {'value': [0, 1]}, 'reflectedEfficiencies': {'value': [.1, 0]},
                       'transmittedEfficiencies': {'value': [0, .7]}}}]}
    assert len(build_gratings(config, scene, solids)) == 1
    return config, scene, solids


@pytest.mark.parametrize('name,value', [('orders', [1, 1]), ('orders', [.5, 1]), ('orders', []),
    ('reflectedEfficiencies', [.4, 0]), ('transmittedEfficiencies', [.1]),
    ('reflectedEfficiencies', [float('nan'), 0]), ('transmittedEfficiencies', [-.1, 0]),
    ('spacing', 0), ('spacing', float('inf')), ('grooveDirection', [0, 0, 1])])
def test_runtime_grating_parameter_validation(grating_configuration, name, value):
    config, scene, solids = grating_configuration
    config['boundaryConditions'][0]['parameters'][name]['value'] = value
    with pytest.raises(ValueError):
        build_gratings(config, scene, solids)


@pytest.mark.parametrize('method', ['ray.diffraction-grating', 'ray.absorbing-detector', 'ray.thin-film-stack',
                                   'ray.abg-scatter', 'ray.lambertian-scatter'])
def test_runtime_surface_conflict_validation(grating_configuration, method):
    config, scene, solids = grating_configuration
    rule = config['boundaryConditions'][0]
    config['boundaryConditions'].append(dict(rule, methodId=method))
    with pytest.raises(ValueError, match='cannot overlap'):
        build_gratings(config, scene, solids)


def test_runtime_rejects_curved_or_multiple_grating_faces(grating_configuration):
    config, scene, solids = grating_configuration
    group = scene['surfaceGroups'][1]
    group['selectors'].append(dict(group['selectors'][0], surfaceIndex=5))
    with pytest.raises(ValueError, match='one surface'):
        build_gratings(config, scene, solids)
    group['selectors'] = [dict(group['selectors'][0], surfaceIndex=0)]
    root = scene['roots'][1]
    root['node']['child'].update(primitive='sphere', parameters={'radius': 1})
    solids['glass'] = AnalyticSolid(root)
    with pytest.raises(ValueError, match='planar'):
        build_gratings(config, scene, solids)
