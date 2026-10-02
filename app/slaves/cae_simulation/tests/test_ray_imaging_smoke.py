"""Real child execution, deterministic reduction and persisted Calculation replay."""
import asyncio
import json
from pathlib import Path
import subprocess

import numpy as np
import pytest
from caemble_catalog import open_catalog
from app.kernel.transport.local import run_local
from tests.imaging_spectrometer_fixtures import trace_imager, imager_metrics
from tests.recording_fixtures import decode_tensor_tree


@pytest.mark.asyncio
async def test_nominal_spatial_patterns_paths_and_parallel_results(catalog_builds):
    measurement = catalog_builds['transmission-imaging-spectrometer']
    results = []
    for paths, budget in [(0, 1), (192, 1), (192, 2)]:
        result = await trace_imager(measurement, budget=budget, paths=paths)
        metrics = imager_metrics(result)
        assert metrics['u'][0] - metrics['u'][-1] == pytest.approx(2.50, abs=.025)
        assert metrics['v'][1] < metrics['v'][2] < metrics['v'][3]  # red, green, blue patches
        assert metrics['v'][3] - metrics['v'][1] > .9
        assert metrics['power'].sum() == pytest.approx(result.observations['detectedPower'])
        assert result.observations['recordedPaths'] == paths
        if paths:
            events = result.visualizations['paths'].members['segmentEvent']['value']
            assert {1, 5, 11, 12} <= set(events)
        results.append(result)
    for result in results[1:]:
        for name in result.artifacts:
            np.testing.assert_array_equal(result.artifacts[name]['value'], results[0].artifacts[name]['value'])
    for name in results[1].visualizations['paths'].members:
        np.testing.assert_array_equal(results[1].visualizations['paths'].members[name]['value'],
                                      results[2].visualizations['paths'].members[name]['value'])


@pytest.mark.asyncio
async def test_saved_calculations_export_and_replay(catalog_builds, tmp_path):
    measurement = catalog_builds['transmission-imaging-spectrometer']
    with open_catalog() as catalog:
        revision = catalog.meta()['catalogRevision']
        calculations = catalog.experiment('transmission-imaging-spectrometer')['calculations']
    # Keep the public CLI artifact manifest/relative input identity intact for export.
    input_file = next(path for path in catalog_builds.root.glob('*/artifact-*/items/1.json')
                      if json.loads(path.read_text(encoding='utf-8'))['measurement'] == measurement)
    saved = tmp_path / 'result'
    manifest = await run_local(input_file, saved, revision, 150, asyncio.Event())
    assert manifest['state'] == 'succeeded'
    packet = json.loads((saved / manifest['records'][0]['path']).read_text(encoding='utf-8'))
    attachments = {a['id']: (saved / a['path']).read_bytes() for a in packet['attachments']}
    power = decode_tensor_tree(packet['schema'], packet['value'], attachments)['']
    assert power.shape == (1280, 720, 1, 1, 5, 1, 1)
    assert power.sum() == pytest.approx(manifest['trace'][0]['observations']['detectedPower'])
    repo = Path(__file__).resolve().parents[4]
    cli = ['node', str(repo / 'app/ui/dist-cli/caemble.cjs'), '--repo', str(repo)]
    exported = tmp_path / 'exported'
    completed = subprocess.run([*cli, 'data', 'export', '--result', str(saved), '--out', str(exported)],
                               capture_output=True, text=True, encoding='utf-8')
    assert completed.returncode == 0, completed.stdout + completed.stderr
    moved = tmp_path / 'moved'
    exported.rename(moved)
    for index, calculation in enumerate(calculations):
        source = tmp_path / f'calculation-{index}.js'
        source.write_text(calculation['source_code'], encoding='utf-8')
        outputs = []
        for directory in (saved, moved):
            output = tmp_path / f'{directory.name}-{index}.json'
            completed = subprocess.run([*cli, 'calculation', 'run', str(source), '--result', str(directory), '--out', str(output)],
                capture_output=True, text=True, encoding='utf-8', timeout=60)
            assert completed.returncode == 0, completed.stdout + completed.stderr
            outputs.append(json.loads(output.read_text(encoding='utf-8'))['output'])
        assert outputs[0] == outputs[1]
        assert np.all(np.isfinite(outputs[0]['data']))


def test_uncertain_dimensions_rebuild_geometry_and_lens_parameters(catalog_builds):
    original = catalog_builds['transmission-imaging-spectrometer']
    variables = original['experiment']['variables']
    changed = catalog_builds.measurement('transmission-imaging-spectrometer', {
        **variables, 'cameraCaseSizeX': 48, 'cameraFrontPrincipalOffset': 11,
        'cameraEntrancePupilOffset': 11, 'cameraPupilDiameter': 11, 'cameraLength': 55})
    assert original['experiment']['scene'] != changed['experiment']['scene']
    original_config = original['experiment']['simulationProgram']['tasks']['trace']['config']
    changed_config = changed['experiment']['simulationProgram']['tasks']['trace']['config']
    lens = changed_config['boundaryConditions'][2]['parameters']
    assert lens['frontPrincipalOffset']['value'] == pytest.approx(11)
    assert lens['frontPrincipalOffset']['unit'] == 'mm'
    assert lens['entrancePupilDiameter']['value'] == pytest.approx(11)
    cosmetic = catalog_builds.measurement('transmission-imaging-spectrometer', {**variables, 'cameraCaseSizeX': 48})
    assert original_config == cosmetic['experiment']['simulationProgram']['tasks']['trace']['config']
    selected = {root for group in original['experiment']['scene']['geometryGroups'] if group['name'] == 'rayDomain' for root in group['rootIds']}
    assert [r for r in original['experiment']['scene']['roots'] if r['id'] in selected] == [
        r for r in cosmetic['experiment']['scene']['roots'] if r['id'] in selected]
