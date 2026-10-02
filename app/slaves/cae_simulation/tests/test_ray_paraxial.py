"""Independent cardinal-plane optics and non-sequential transfer contracts."""
from dataclasses import replace
from types import SimpleNamespace
import numpy as np
import pytest
from app.methods.geometry.analytic import AnalyticSolid
from app.methods.optics import unit_vector
from app.methods.rays.analytic import AnalyticScene
from app.solvers.ray_tracing.formulation import Ray, _trace_one
from app.solvers.ray_tracing.outputs import PathCollector
from app.solvers.ray_tracing.paraxial import ParaxialLens, build_lenses


@pytest.fixture
def lens():
    return ParaxialLens(np.zeros(3), np.eye(3), .06, .02, .025, .02, -.0125,
                        .02, -.0125, .02, .02, .8)


@pytest.mark.parametrize('height', [-.003, 0., .003])
def test_parallel_focus_and_reverse_collimation(lens, height):
    position, direction = lens.transfer(np.array([height, 0, -.03]), np.array([0., 0., 1.]))
    image_z = .03 + lens.rear_principal + lens.focal_length
    focus = position + (image_z - position[2]) / direction[2] * direction
    np.testing.assert_allclose(focus, [0, 0, image_z], atol=1e-15)
    start, backward = lens.transfer(position, -direction)
    np.testing.assert_allclose(start, [height, 0, -.03], atol=1e-15)
    np.testing.assert_allclose(backward, [0, 0, -1], atol=1e-15)


@pytest.mark.parametrize('object_height', [-.002, 0., .002])
def test_finite_conjugate_and_magnification(lens, object_height):
    distance = .5
    image_distance = 1 / (1 / lens.focal_length - 1 / distance)
    object_point = np.array([object_height, 0, -.03 + lens.front_principal - distance])
    for pupil_height in (-.003, 0., .003):
        entry = np.array([pupil_height, 0., -.03])
        point, direction = lens.transfer(entry, unit_vector(entry - object_point))
        image_z = .03 + lens.rear_principal + image_distance
        image = point + (image_z - point[2]) / direction[2] * direction
        np.testing.assert_allclose(image, [-object_height * image_distance / distance, 0., image_z], atol=1e-15)


def test_rotation_translation_and_reciprocity(lens):
    a = .31
    rotation = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    center = np.array([.4, -.3, .8])
    transformed = replace(lens, center=center, rotation=rotation)
    entry, direction = np.array([.002, -.001, -.03]), unit_vector(np.array([.03, .01, 1.]))
    point, output = lens.transfer(entry, direction)
    actual_point, actual_output = transformed.transfer(center + rotation @ entry, rotation @ direction)
    np.testing.assert_allclose(actual_point, center + rotation @ point, atol=1e-14)
    np.testing.assert_allclose(actual_output, rotation @ output, atol=1e-14)
    back, backward = transformed.transfer(actual_point, -actual_output)
    np.testing.assert_allclose(back, center + rotation @ entry, atol=1e-14)
    np.testing.assert_allclose(backward, -rotation @ direction, atol=1e-14)


def test_pupils_and_housing_length_is_not_air_translation(lens):
    entry, direction = np.array([.003, 0, -.03]), np.array([0., 0., 1.])
    for change in ({'entrance_radius': .001}, {'exit_radius': .001}, {'radius': .001}):
        assert replace(lens, **change).transfer(entry, direction) is None
    point, output = lens.transfer(entry, direction)
    point2, output2 = replace(lens, length=.08).transfer(entry - [0, 0, .01], direction)
    np.testing.assert_allclose(point2[:2], point[:2], atol=1e-15)
    np.testing.assert_allclose(output2, output, atol=1e-15)


@pytest.fixture
def lens_scene():
    solid = AnalyticSolid({'id': 'lens', 'node': {'kind': 'primitive', 'nodeId': 'cylinder', 'primitive': 'cylinder',
                          'parameters': {'radius': .02, 'radius_2': .02, 'height': .06}}}, 1.)
    scene = {'roots': [{'id': 'lens'}], 'geometryGroups': [{'name': 'lens', 'rootIds': ['lens']}],
             'surfaceGroups': [{'name': 'cap', 'selectors': [{'rootId': 'lens', 'sourceNodeId': 'cylinder', 'surfaceIndex': 0}]}]}
    config = {'boundaryConditions': [{'methodId': 'ray.paraxial-lens', 'target': ['experiment.geometry.lens'], 'parameters': {
        'focalLength': .025, 'frontPrincipalOffset': .02, 'rearPrincipalOffset': -.0125,
        'entrancePupilOffset': .02, 'exitPupilOffset': -.0125,
        'entrancePupilDiameter': .04, 'exitPupilDiameter': .04, 'transmission': .8}}]}
    return config, scene, {'lens': solid}


@pytest.mark.parametrize('parameter,value', [('focalLength', 0), ('focalLength', np.nan),
    ('entrancePupilDiameter', 0), ('exitPupilDiameter', -1), ('transmission', 1.1)])
def test_invalid_parameters(lens_scene, parameter, value):
    config, scene, solids = lens_scene
    config['boundaryConditions'][0]['parameters'][parameter] = value
    with pytest.raises(ValueError, match='Paraxial lens requires'):
        build_lenses(config, scene, solids)


@pytest.mark.parametrize('method', ['ray.diffraction-grating', 'ray.thin-film-stack', 'ray.absorbing-detector', 'ray.lambertian-scatter'])
def test_overlapping_surface_rules(lens_scene, method):
    config, scene, solids = lens_scene
    config['boundaryConditions'].append({'methodId': method, 'target': ['experiment.surface.cap'], 'parameters': {}})
    with pytest.raises(ValueError, match='cannot overlap'):
        build_lenses(config, scene, solids)


def test_transfer_preserves_state_skips_internal_volume_and_self_hit(lens_scene):
    config, authored, solids = lens_scene
    lenses = build_lenses(config, authored, solids)
    scene = AnalyticScene(solids.values())
    ray = Ray(np.array([.002, 0., -.1]), np.array([0., 0., 1.]), np.array([1., 0., 0.]),
              np.array([1., .2, .3, .1]), 550e-9, 1., 0)
    scored = []
    collector = PathCollector(8, tallies=[SimpleNamespace(score=lambda *args: scored.append(args))])
    branches = _trace_one(ray, scene, {}, {}, {}, {}, {}, {}, 10, 1e-9, 1, collector, lenses=lenses)
    assert branches == [ray] and ray.interactions == 1
    assert ray.medium_stack == [] and ray.medium_name is None and ray.wavelength == 550e-9
    np.testing.assert_allclose(ray.stokes, [.8, .16, .24, .08])
    assert np.dot(ray.basis, ray.direction) == pytest.approx(0., abs=1e-15)
    assert ray.events == [1, 12]
    assert len(scored) == 1 and scored[0][2] == pytest.approx(.07)
    assert scene.intersect(ray.origin, ray.direction, previous=ray.last_hit) is None


def test_duplicate_lens_and_nested_solid_are_rejected(lens_scene):
    config, scene, solids = lens_scene
    config['boundaryConditions'].append(config['boundaryConditions'][0])
    with pytest.raises(ValueError, match='cannot overlap'):
        build_lenses(config, scene, solids)
    config['boundaryConditions'].pop()
    solids['inside'] = AnalyticSolid({'id': 'inside', 'node': {'kind': 'primitive', 'nodeId': 'box',
        'primitive': 'box', 'parameters': {'size': [.001, .001, .001]}}}, 1.)
    with pytest.raises(ValueError, match='cannot contain'):
        build_lenses(config, scene, solids)


def test_bulk_scattering_on_equivalent_lens_is_rejected(lens_scene):
    config, scene, solids = lens_scene
    config['boundaryConditions'].append({'methodId': 'ray.hg-medium',
        'target': ['experiment.geometry.lens'], 'parameters': {'anisotropy': 0.}})
    with pytest.raises(ValueError, match='cannot overlap'):
        build_lenses(config, scene, solids)


def test_removed_solver_version_has_no_fallback():
    from caemble_catalog import CatalogNotFoundError, open_catalog
    with open_catalog() as catalog:
        with pytest.raises(CatalogNotFoundError):
            catalog.get_solver_manifest('ray-tracing', '5.0.0')
        assert catalog.get_solver_manifest('ray-tracing', '5.1.0')['descriptor']['version'] == '5.1.0'
