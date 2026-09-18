"""Small physical grating/substrate traces; product calls require the smoke tier."""
from copy import deepcopy

import numpy as np
import pytest

from app.kernel.api import SolverInvocation
from app.kernel.coordinator.plan import RunPlan, detached
from app.kernel.execution import SpawnSolverExecutor
from tests.ray_parallel_fixtures import scattering_ray_invocation


@pytest.mark.asyncio
async def test_two_sided_pixel_response_paths_and_parallel_reduction(catalog_builds):
    measurement = catalog_builds['transmission-grating-response']
    program = measurement['experiment']['simulationProgram']
    plan = RunPlan.prepare(measurement, program['tasks'], program['recordedData'])
    spec = plan.task_specs['trace']
    results = []
    for limit, budget in [(0, 1), (128, 1), (128, 2), (8192, 1)]:
        config = detached(spec.task['config'])
        config['parameters']['maxPaths'] = limit
        result = await SpawnSolverExecutor(cpu_budget=budget).execute(spec.locator,
            SolverInvocation(config=config, state={}, inputs={}, world=plan.world(spec),
                             geometry=None, progress=None, descriptor=detached(spec.descriptor)), timeout=60)
        results.append(result)
        reflected, transmitted = [result.artifacts[name]['value'] for name in ('reflectedPower', 'transmittedPower')]
        assert .3 <= reflected.sum() < .35
        assert 1.9 < transmitted.sum() < 2.1
        assert reflected.sum() + transmitted.sum() == pytest.approx(result.observations['detectedPower'])
        np.testing.assert_array_equal(result.artifacts['launchedPower']['value'].ravel(), [1, 1, 1])
        # Independently predicted sensor-local positions for 650, 550, 450 nm.
        profile = transmitted[:, :, 0, 0, :, 0, 0].sum(axis=1)
        centers = ((np.arange(96) + .5) * .25) @ profile / profile.sum(axis=0)
        wavelengths = np.array([.00065, .00055, .00045])  # mm
        tangents = -wavelengths * 600
        expected = 22 + tangents / np.sqrt(1.5 ** 2 - tangents ** 2) + 28.95 * tangents / np.sqrt(1 - tangents ** 2)
        np.testing.assert_allclose(centers, expected, atol=.15)
        bundle = result.visualizations['paths'].members
        events = bundle['segmentEvent']['value']
        offsets = bundle['pathOffsets']['value']
        if limit:
            paths = [events[first - i:end - i - 1].tolist() for i, (first, end) in enumerate(zip(offsets[:-1], offsets[1:]))]
            assert [11, 5] in paths  # direct grating reflection to detector
            assert [11, 1, 5] in paths  # grating transmission, ordinary rear refraction, detector
            assert any(path.count(11) >= 2 for path in paths)  # rear reflection revisits grating
        else:
            assert offsets.tolist() == [0]
    for result in results[1:]:
        assert result.observations['detectedPower'] == results[0].observations['detectedPower']
        for name in result.artifacts:
            np.testing.assert_array_equal(result.artifacts[name]['value'], results[0].artifacts[name]['value'])
    for name in results[1].visualizations['paths'].members:
        np.testing.assert_array_equal(results[1].visualizations['paths'].members[name]['value'],
                                      results[2].visualizations['paths'].members[name]['value'])


@pytest.mark.asyncio
@pytest.mark.parametrize('reflected,transmitted', [(.1, .7), (0., .7), (.1, 0.)])
async def test_normal_substrate_transmission_absorption_and_backward_grating(reflected, transmitted):
    invocation = scattering_ray_invocation(count=1, maximum_paths=100)
    invocation.config['boundaryConditions'] = [invocation.config['boundaryConditions'][0], {
        'methodId': 'ray.diffraction-grating', 'target': ['experiment.surface.glass'],
        'parameters': {'spacing': {'value': 1e-6}, 'grooveDirection': {'value': [0, 1, 0]},
                       'orders': {'value': [0]}, 'reflectedEfficiencies': {'value': [reflected]},
                       'transmittedEfficiencies': {'value': [transmitted]}}}]
    # Equal-index slab removes Fresnel splitting: 0.7 W enters, then Beer attenuation over 1 m.
    models = invocation.world['materials']['experiment']['Glass']['models']
    models['index']['parameters']['n']['value'] = 1.
    models['absorption']['parameters']['alpha']['value'] = np.log(2.)
    result = await SpawnSolverExecutor(cpu_budget=1).execute('app.solvers.ray_tracing.entry:implementation', deepcopy(invocation), timeout=30)
    assert result.observations['detectedPower'] == pytest.approx(transmitted / 2, abs=1e-14)
    # Move the grating to the exit side. The ordinary entry now establishes the incident medium.
    invocation.world['experiment']['surfaceGroups'][1]['selectors'][0]['surfaceIndex'] = 5
    result = await SpawnSolverExecutor(cpu_budget=1).execute('app.solvers.ray_tracing.entry:implementation', invocation, timeout=30)
    assert result.observations['detectedPower'] == pytest.approx(transmitted / 2, abs=1e-14)
