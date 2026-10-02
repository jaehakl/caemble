"""Hand-computable surface power and observer independence checks."""
from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest
from app.methods.fields.box_grid import BoxGrid
from app.methods.geometry import GeometryService
from app.methods.geometry.analytic import SurfaceRef
from app.solvers.ray_tracing.detector import DetectorTally, launched_power_artifacts
from app.solvers.ray_tracing.formulation import launch_sources
from app.solvers.ray_tracing.outputs import PathCollector


def tally(rotation=None, origin=None):
    grid = BoxGrid({'size': [4., 2., .2], 'origin': origin or [0., 0., -.1],
                    'rotation': np.eye(3).tolist() if rotation is None else rotation,
                    'lengthUnit': 'm', 'gridShape': [2, 2, 1], 'source': 'experiment', 'rootId': 'sensor'})
    data = {'dtype': 'float64', 'quantityKind': 'optics.RadiantFlux', 'unit': 'W',
            'boxGrid': {'version': 1, 'sampling': 'surface-integral', 'frequencyKind': 'source-sampled',
                        'components': ['value'], 'channels': ['value'], 'channelUnits': ['W']}}
    return DetectorTally('pixels', grid, data, np.array([299792458 / 600e-9, 299792458 / 500e-9]), SurfaceRef('sensor', 'body', 5))


def test_centers_boundaries_exterior_and_unequal_power():
    detector = tally()
    for position, power in [([1, .5, 0], 2), ([2, 1, 0], 3), ([4, 2, 0], 5), ([0, 0, 0], 7),
                            ([4, 0, 0], 11), ([0, 2, 0], 13), ([-1e-7, 1, 0], 100), ([4+1e-7, 1, 0], 100),
                            ([1, -.001, 0], 100), ([1, 2.001, 0], 100), ([1, 1, .01], 100)]:
        detector.score_hit(position, power, 600e-9)
    detector.score_hit([1, .5, 0], 17, 500e-9)
    np.testing.assert_array_equal(detector.values[:, :, 0, 0, 0], [[9, 13], [11, 8]])
    assert detector.values[0, 0, 0, 1, 0] == 17
    artifact = detector.artifact()
    assert artifact['value'].shape == (2, 2, 1, 1, 2, 1, 1)
    np.testing.assert_array_equal(artifact['axes'][0]['ticks'], [1, 3])
    np.testing.assert_array_equal(artifact['axes'][1]['ticks'], [.5, 1.5])
    np.testing.assert_array_equal(artifact['axes'][2]['ticks'], [.1])
    assert artifact['value'].sum() == 58


def test_rotated_translated_detector_and_mm_units():
    detector = tally([[0, 0, 1], [1, 0, 0], [0, 1, 0]], [10, 20, 30])
    detector.score_hit([10.1, 23, 31.5], 19, 500e-9)
    assert detector.values[1, 1, 0, 1, 0] == 19
    grid = dict(detector.grid.geometry)
    grid.update(size=[4000, 2000, 200], origin=[10000, 20000, 30000], lengthUnit='mm')
    converted = DetectorTally('pixels', BoxGrid(grid), detector.data, detector.frequencies, detector.surface)
    converted.score_hit([10.1, 23, 31.5], 19, 500e-9)
    np.testing.assert_array_equal(converted.values, detector.values)
    distant = tally(origin=[1e6, 2e6, 3e6])
    distant.score_hit([1e6 + 2, 2e6 + 1, 3e6 + .1], 23, 600e-9)
    distant.score_hit([1e6 - 1e-5, 2e6 + 1, 3e6 + .1], 100, 600e-9)
    assert distant.values[1, 1, 0, 0, 0] == 23
    assert distant.values.sum() == 23


def test_batch_merge_sums_pixels_even_without_paths():
    collector = PathCollector(0, detector_tallies=[tally()])
    for power in [2, 3, 7]:
        other = PathCollector(0, detected_power=power, detector_tallies=[tally()])
        other.detector_tallies[0].score_hit([1, .5, 0], power, 600e-9)
        collector.merge(other)
    assert collector.detected_power == 12
    assert collector.detector_tallies[0].values.sum() == 12
    assert collector.paths == []


def test_launched_power_is_a_frequency_aggregate_not_a_spatial_filter():
    detector = tally()
    geometry = dict(detector.grid.geometry, gridShape=[1, 1, 1], origin=[1000, 1000, 1000])
    data = deepcopy(detector.data)
    data['boxGrid']['sampling'] = 'aggregate'
    descriptor = {'methods': {'outputs': [{'methodId': 'ray.launched-power', 'data': data}]}}
    config = {'outputs': [{'key': 'launched', 'methodId': 'ray.launched-power', 'boxGrid': geometry}]}
    result = launched_power_artifacts(config, descriptor, {6e14: 7., 5e14: 11.})['launched']
    np.testing.assert_array_equal(result['value'].ravel(), [11, 7])
    np.testing.assert_array_equal(result['axes'][4]['ticks'], [5e14, 6e14])
    assert result['value'].shape == (1, 1, 1, 1, 2, 1, 1)


@pytest.mark.asyncio
async def test_sources_share_frequency_bins_without_normalizing_power_twice():
    scene = {'version': 2, 'geometryHash': 'source-power', 'lengthUnit': 'm',
             'roots': [{'id': 'emitter', 'node': {'kind': 'primitive', 'primitive': 'box',
                        'nodeId': 'emitter', 'parameters': {'size': [1, 1, 1]}}}],
             'geometryGroups': [{'name': 'source', 'rootIds': ['emitter']}], 'surfaceGroups': []}
    async def progress(value):
        pass
    context = SimpleNamespace(geometry=GeometryService(), descriptor={'referenceLengthUnit': 'm'}, progress=progress)
    rules = [{'methodId': 'ray.point-source', 'target': ['experiment.geometry.source'],
              'parameters': {'wavelength': wavelength, 'radiantFlux': power, 'rayCount': count,
                             'stokes': [1, 0, 0, 0], 'direction': [0, 0, 1], 'coneHalfAngle': 0}}
             for wavelength, power, count in [(600e-9, 6, 2), (500e-9, 5, 1), (600e-9, 8, 4)]]
    rays, launched = await launch_sources(context, {'initializations': rules}, scene, {}, 1)
    assert launched == {299792458 / 600e-9: 14, 299792458 / 500e-9: 5}
    np.testing.assert_array_equal([ray.stokes[0] for ray in rays], [3, 3, 5, 2, 2, 2, 2])
