"""Execute the catalog's actual TypeScript bundle and canonical optical scene.

Requires the built Caemble CLI and Node.js. The CLI only builds the input;
this test traces its canonical geometry in real spawn children at two resolutions.
"""
from copy import deepcopy
import json
import subprocess
from pathlib import Path

import numpy as np
import pytest

from app.kernel.api import SolverInvocation
from app.kernel.coordinator.plan import RunPlan, detached
from app.kernel.execution import SpawnSolverExecutor


@pytest.mark.asyncio
async def test_catalog_spectrometer_separates_three_lines_and_converges(tmp_path: Path):
    repo = Path(__file__).resolve().parents[4]
    artifact = tmp_path / 'spectrometer'
    materials = tmp_path / 'source-only-materials.json'
    materials.write_text(json.dumps({'names': [], 'materials': [], 'parameters': [], 'qualifiers': []}), encoding='utf-8')
    subprocess.run([
        'node', str(repo / 'app/ui/dist-cli/caemble.cjs'), '--repo', str(repo),
        'experiment', 'build', '--example', 'czerny-turner-spectrometer',
        '--vars-mode', 'nominal', '--out', str(artifact),
        '--materials', str(materials),
    ], cwd=repo, check=True, capture_output=True, text=True, encoding='utf-8')
    manifest = json.loads((artifact / 'manifest.json').read_text(encoding='utf-8'))
    assert len(manifest['items']) == 1
    item = json.loads((artifact / manifest['items'][0]['file']).read_text(encoding='utf-8'))
    measurement = item['measurement']
    program = measurement['experiment']['simulationProgram']
    plan = RunPlan.prepare(measurement, program['tasks'], program['recordedData'])
    spec = plan.task_specs['trace']
    world = plan.world(spec)
    refined_world = deepcopy(world)
    nodes = [root['node'] for root in refined_world['experiment']['roots']]
    while nodes:
        node = nodes.pop()
        if node['kind'] == 'primitive' and node['primitive'] == 'sphere':
            node['parameters']['segments'] *= 2
        if 'child' in node:
            nodes.append(node['child'])
        nodes.extend(node.get('children', []))
    # A new geometry identity avoids a cache hit at the coarser resolution.
    refined_world['experiment']['geometryHash'] += '-refined'
    centers_by_resolution = []
    powers = []
    for input_world in [world, refined_world]:
        result = await SpawnSolverExecutor().execute(
            spec.locator,
            SolverInvocation(config=detached(spec.task['config']), state={'upstream': 7}, inputs={}, world=input_world,
                             geometry=None, progress=None, descriptor=detached(spec.descriptor)),
        )
        assert result.state_patch.operations[0].path == ('rayPaths',)
        bundle = result.artifacts['rayPaths'].members
        vertices = bundle['vertices']['value']
        offsets = bundle['pathOffsets']['value']
        events = bundle['segmentEvent']['value']
        wavelengths = bundle['pathWavelength']['value']
        assert set(np.unique(events)) >= {0, 5, 7, 11}
        assert len(offsets) == len(wavelengths) + 1
        assert offsets[-1] == len(vertices)
        assert len(events) == len(vertices) - len(wavelengths)
        centers = []
        intervals = []
        dispersion_axis = np.array([np.cos(np.deg2rad(-35)), np.sin(np.deg2rad(-35)), 0])
        for wavelength in np.unique(wavelengths):
            positions = []
            for index in np.flatnonzero(wavelengths == wavelength):
                first, end = offsets[index:index + 2]
                path_events = events[first - index:end - index - 1]
                if path_events[-1] == 5:
                    assert list(path_events) == [0, 11, 0, 5]
                    positions.append(float(vertices[end - 1] @ dispersion_axis))
            assert len(positions) == 1024
            centers.append(np.mean(positions))
            intervals.append(np.quantile(positions, [.05, .95]))
        assert len(centers) == 3
        assert np.all(np.diff(centers) > 0.004)
        assert all(intervals[i][1] < intervals[i+1][0] for i in range(2))
        centers_by_resolution.append(centers)
        power = result.artifacts['detectorPower']['value']
        efficiency = result.artifacts['detectorEfficiency']['value']
        assert 1.7 < power < 2.1
        assert efficiency == pytest.approx(power / 3)
        powers.append(power)
    np.testing.assert_allclose(centers_by_resolution[0], centers_by_resolution[1], atol=0.0001, rtol=0)
    assert powers[0] == pytest.approx(powers[1], rel=1e-3)
