"""Small real-child checks for passive power observations and batch reduction."""
from copy import deepcopy

import numpy as np
import pytest

from app.kernel.execution import SpawnSolverExecutor, RemoteSolverError
from app.kernel.api import SolverInvocation
from app.kernel.coordinator.plan import RunPlan, detached
from tests.ray_parallel_fixtures import scattering_ray_invocation


@pytest.mark.asyncio
async def test_detector_outputs_do_not_change_physics_and_parallel_pixels_match():
    invocation = scattering_ray_invocation(count=512, maximum_paths=0)
    grid = {'origin': [-2, -2, 1.85], 'size': [4, 4, .2], 'rotation': np.eye(3).tolist(),
            'gridShape': [4, 4, 1], 'lengthUnit': 'm', 'source': 'experiment', 'rootId': 'observation'}
    baseline = await SpawnSolverExecutor(cpu_budget=1).execute('app.solvers.ray_tracing.entry:implementation', deepcopy(invocation), timeout=60)
    expected = baseline.observations['detectedPower']
    assert 0 < expected < 1
    first_pixels = None
    for paths, budget, shape, thickness in [(0, 1, [4, 4, 1], .2), (2, 1, [4, 4, 1], .2), (2048, 2, [4, 4, 1], .2), (0, 1, [8, 2, 1], .6)]:
        current = deepcopy(invocation)
        current.config['parameters']['maxPaths'] = paths
        current_grid = dict(grid, gridShape=shape, size=[4, 4, thickness], origin=[-2, -2, 1.95 - thickness / 2])
        current.config['outputs'] = [
            {'key': name, 'methodId': 'ray.detector-power', 'target': ['experiment.geometry.observation'],
             'parameters': {'surface': 'experiment.surface.detector'}, 'boxGrid': current_grid}
            for name in (['pixels'] if paths == 2 else ['pixels', 'secondObserver'])]
        current.config['outputs'].append({'key': 'launched', 'methodId': 'ray.launched-power',
                                         'target': ['experiment.geometry.observation'], 'parameters': {},
                                         'boxGrid': dict(current_grid, gridShape=[1, 1, 1])})
        result = await SpawnSolverExecutor(cpu_budget=budget).execute('app.solvers.ray_tracing.entry:implementation', current, timeout=60)
        assert result.observations['detectedPower'] == pytest.approx(expected, rel=1e-12)
        pixels = result.artifacts['pixels']['value']
        assert pixels.sum() == pytest.approx(expected, rel=1e-12)
        if 'secondObserver' in result.artifacts:
            np.testing.assert_array_equal(pixels, result.artifacts['secondObserver']['value'])
        assert result.artifacts['launched']['value'].item() == 1
        if paths == 2048:
            # Fresnel branches add paths; this limit retains every completed path.
            assert 512 <= result.observations['recordedPaths'] < paths
        else:
            assert result.observations['recordedPaths'] == paths
        if shape == [4, 4, 1]:
            if first_pixels is None:
                first_pixels = pixels.copy()
            else:
                np.testing.assert_array_equal(first_pixels, pixels)


@pytest.mark.asyncio
async def test_mismatched_detector_box_is_rejected_before_trace():
    invocation = scattering_ray_invocation(count=1, maximum_paths=0)
    invocation.config['outputs'] = [{'key': 'pixels', 'methodId': 'ray.detector-power', 'target': [],
        'parameters': {'surface': 'experiment.surface.detector'},
        'boxGrid': {'origin': [-1, -1, 1.85], 'size': [2, 2, .2], 'rotation': np.eye(3).tolist(),
                    'gridShape': [2, 2, 1], 'lengthUnit': 'm', 'source': 'experiment', 'rootId': 'observation'}}]
    with pytest.raises(RemoteSolverError, match='full face'):
        await SpawnSolverExecutor(cpu_budget=1).execute('app.solvers.ray_tracing.entry:implementation', invocation, timeout=30)


@pytest.mark.asyncio
async def test_pixel_example_samples_detector_paths_without_changing_power(catalog_builds):
    measurement = catalog_builds['pixel-monochromatic-response']
    program = measurement['experiment']['simulationProgram']
    plan = RunPlan.prepare(measurement, program['tasks'], program['recordedData'])
    spec = plan.task_specs['trace']
    results = []
    for limit in [0, 64, 4096]:
        config = detached(spec.task['config'])
        config['parameters']['maxPaths'] = limit
        result = await SpawnSolverExecutor(cpu_budget=1).execute(spec.locator,
            SolverInvocation(config=config, state={}, inputs={}, world=plan.world(spec),
                             geometry=None, progress=None, descriptor=detached(spec.descriptor)), timeout=60)
        results.append(result)
        bundle = result.visualizations['paths'].members
        offsets = bundle['pathOffsets']['value']
        events = bundle['segmentEvent']['value']
        if limit == 0:
            assert offsets.tolist() == [0]
        else:
            assert any(events[first - index:end - index - 1].tolist() == [0, 11, 0, 5]
                       for index, (first, end) in enumerate(zip(offsets[:-1], offsets[1:])))
            if limit == 64:
                assert result.observations['recordedPaths'] == 64
            else:
                assert 64 < len(offsets) - 1 < limit
    for result in results[1:]:
        assert result.observations['detectedPower'] == results[0].observations['detectedPower']
        for name in result.artifacts:
            np.testing.assert_array_equal(result.artifacts[name]['value'], results[0].artifacts[name]['value'])
