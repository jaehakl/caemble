"""Execute the catalog's actual TypeScript bundle and canonical optical scene.

Requires the UI's installed npm dependencies and Node.js. The test invokes the
same authoring policy, type declarations and geometry evaluator as the UI,
then traces the exported geometry in real spawn children at two resolutions.
"""
import json
import subprocess
from pathlib import Path

import numpy as np
import pytest

from app.kernel.api import SolverInvocation
from app.kernel.catalog.normalization import normalize_task_config
from app.kernel.execution import SpawnSolverExecutor


@pytest.mark.asyncio
async def test_catalog_spectrometer_separates_three_lines_and_converges(tmp_path: Path):
    ui = Path(__file__).resolve().parents[3] / 'ui'
    subprocess.run([
        'node', 'node_modules/esbuild/bin/esbuild', 'scripts/test-spectrometer.ts',
        '--bundle', '--platform=node', '--format=esm', '--external:typescript', '--external:@babel/*',
        '--alias:@=./src', '--outfile=node_modules/.tmp/test-spectrometer.mjs',
    ], cwd=ui, check=True, capture_output=True, text=True)
    subprocess.run([
        'node', 'node_modules/.tmp/test-spectrometer.mjs',
        str(ui.parent / 'catalog/caemble_catalog/catalog.sqlite3'), str(tmp_path),
    ], cwd=ui, check=True, capture_output=True, text=True, encoding='utf-8')
    centers_by_resolution = []
    powers = []
    for filename in ['measurement.json', 'measurement-refined.json']:
        data = json.loads((tmp_path / filename).read_text(encoding='utf-8'))
        config, _ = normalize_task_config(data['descriptor'], data['task']['config'])
        result = await SpawnSolverExecutor().execute(
            'app.solvers.ray_tracing.entry:implementation',
            SolverInvocation(config=config, state={'upstream': 7}, inputs={}, world=data['world'],
                             geometry=None, progress=None, descriptor=data['descriptor']),
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
