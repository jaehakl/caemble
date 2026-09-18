"""Small physical grating/substrate traces; product calls require the smoke tier."""
from copy import deepcopy
import asyncio
import json

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


@pytest.mark.asyncio
async def test_rotated_films_replay_across_children_and_batch_workers():
    saved_inputs = []
    # Both fixed regressions: repeated entry after diffraction and repeated rear exit.
    cases = [
        (.999838604433591, .01796566403696789, .12267024792692374,
         [-1.6996600614159994e-05, .0001396058599266658, .07],
         [-3.269065001722279e-05, -.0018557101170121677, .9999982776341583]),
        (.9999823208972435, -.005946250327933201, .1192437306685398,
         [-.00020206606634240584, -.0003835484692435692, .07],
         [.006926325427595277, .006021548651563518, .9999578825970161]),
    ]
    for index, (c, s, z, origin, incoming) in enumerate(cases):
        invocation = scattering_ray_invocation(count=512, maximum_paths=128)
        scene = invocation.world['experiment']
        scene['geometryHash'] = f'rotated-film-regression-{index}'
        emitter, glass, detector = scene['roots']
        matrix = np.eye(4)
        matrix[:3, 3] = origin
        emitter['node']['matrix'] = matrix.ravel().tolist()
        emitter['node']['child']['parameters']['size'] = [1e-8] * 3
        glass['node']['matrix'] = [c, 0., s, 0., 0., 1., 0., 0., -s, 0., c, z, 0., 0., 0., 1.]
        glass['node']['child']['parameters']['size'] = [.02, .02, .0000762]
        detector['node']['matrix'][11] = .2
        detector['node']['child']['parameters']['size'] = [.2, .2, .001]
        scene['geometryGroups'].append({'name': 'emitter', 'rootIds': ['emitter']})
        source = invocation.config['initializations'][1]
        source.update(methodId='ray.point-source', target=['experiment.geometry.emitter'])
        source['parameters'].update(direction={'value': incoming}, coneHalfAngle={'value': 0.})
        invocation.config['boundaryConditions'] = [invocation.config['boundaryConditions'][0], {
            'methodId': 'ray.diffraction-grating', 'target': ['experiment.surface.glass'],
            'parameters': {'spacing': {'value': 2e-6}, 'grooveDirection': {'value': [0., -1., 0.]},
                           'orders': {'value': [1]}, 'reflectedEfficiencies': {'value': [0.]},
                           'transmittedEfficiencies': {'value': [1.]}}}]
        models = invocation.world['materials']['experiment']['Glass']['models']
        models['index']['parameters']['n']['value'] = 1.
        models['absorption']['parameters']['alpha']['value'] = 0.
        saved_inputs.append(json.dumps(dict(config=invocation.config, world=invocation.world,
            descriptor=invocation.descriptor, state={}, inputs={}, geometry=None, progress=None)))

    locator = 'app.solvers.ray_tracing.entry:implementation'
    baseline = []
    for saved in saved_inputs:
        baseline.append(await SpawnSolverExecutor(cpu_budget=1).execute(
            locator, SolverInvocation(**json.loads(saved)), timeout=30))
    for maximum_paths in (128, 0):
        invocations = [SolverInvocation(**json.loads(saved)) for saved in saved_inputs]
        for invocation in invocations:
            invocation.config['parameters']['maxPaths'] = maximum_paths
        # Independent input jobs run together; each also uses the real batch-worker path.
        results = await asyncio.gather(*(SpawnSolverExecutor(cpu_budget=2).execute(
            locator, invocation, timeout=30) for invocation in invocations))
        for expected, result in zip(baseline, results):
            assert expected.observations['launchedRays'] == result.observations['launchedRays'] == 512
            assert expected.observations['detectedPower'] == result.observations['detectedPower'] == 1.
            bundle = result.visualizations['paths'].members
            if maximum_paths:
                for name in bundle:
                    np.testing.assert_array_equal(bundle[name]['value'], expected.visualizations['paths'].members[name]['value'])
                assert bundle['segmentEvent']['value'].tolist() == [11, 1, 5] * 128
            else:
                assert bundle['pathOffsets']['value'].tolist() == [0]
