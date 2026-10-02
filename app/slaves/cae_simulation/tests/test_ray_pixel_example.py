"""Fixed Candidates exercise the public CLI, numerical Records and replay."""
import json
from pathlib import Path
import subprocess

import numpy as np
from caemble_catalog import open_catalog
from tests.recording_fixtures import decode_tensor_tree


def command(repo, *arguments, success=True):
    completed = subprocess.run(['node', str(repo / 'app/ui/dist-cli/caemble.cjs'), '--repo', str(repo), *map(str, arguments)],
                               cwd=repo, capture_output=True, text=True, encoding='utf-8', timeout=150)
    if success and completed.returncode:
        raise AssertionError(completed.stdout + completed.stderr)
    if not success:
        assert completed.returncode != 0
    return completed


def test_three_wavelengths_at_three_slit_positions_record_calculate_and_replay(tmp_path):
    repo = Path(__file__).resolve().parents[4]
    with open_catalog() as catalog:
        example = catalog.experiment('pixel-monochromatic-response')
    source = tmp_path / 'source'
    source.mkdir()
    for name, text in example['sourceBundle']['files'].items():
        if name == 'sensor.ts':
            text = text.replace('[550]', '[450, 550, 650]')
        if name == 'experiment.tsx':
            text = text.replace('slitPosition: { min: 0, max: 0 }', 'slitPosition: { min: -0.3, max: 0.3 }')
        if name == 'tasks/trace.tsx':
            text = text.replace('maxPaths: 64', 'maxPaths: 0')
        target = source / name
        target.parent.mkdir(exist_ok=True, parents=True)
        target.write_text(text, encoding='utf-8')
    calculations = {}
    for index, definition in enumerate(example['calculations']):
        path = tmp_path / f'calculation-{index}.js'
        path.write_text(definition['source_code'], encoding='utf-8')
        calculations[definition['name']] = path
    centers = []
    # Build every condition before executing any of them; no Task overrides.
    for index, position in enumerate((-.3, 0, .3)):
        variables = tmp_path / f'vars-{index}.json'
        variables.write_text(json.dumps({'slitPosition': position, 'slitWidth': .05, 'grooveDensity': 600,
                                        'gratingAngle': 0, 'focalLength': 100, 'detectorOffset': 0}), encoding='utf-8')
        command(repo, 'experiment', 'build', source, '--mode', 'candidate', '--vars', variables, '--out', tmp_path / f'build-{index}')
    for index in range(3):
        result = tmp_path / f'result-{index}'
        command(repo, 'experiment', 'test', tmp_path / f'build-{index}', '--out', result, '--timeout', '120')
        manifest = json.loads((result / '1/manifest.json').read_text(encoding='utf-8'))
        assert manifest['state'] == 'succeeded'
        assert manifest['trace'][0]['observations']['recordedPaths'] == 0
        assert manifest['trace'][0]['observations']['launchedRays'] == 768
        records = {item['name']: json.loads((result / '1' / item['path']).read_text(encoding='utf-8')) for item in manifest['records']}
        signal = records['detectorPower']['value']
        assert signal['shape'] == [96, 32, 1, 1, 3, 1, 1]
        packet = records['detectorPower']
        attachments = {item['id']: (result / '1' / item['path']).read_bytes() for item in packet['attachments']}
        values = decode_tensor_tree(packet['schema'], signal, attachments)['']
        np.testing.assert_allclose(values.sum(), manifest['trace'][0]['observations']['detectedPower'], rtol=1e-12)
        outputs = {}
        for name, path in calculations.items():
            destination = tmp_path / f'output-{index}-{path.stem}.json'
            command(repo, 'calculation', 'run', path, '--result', result / '1', '--out', destination)
            outputs[name] = json.loads(destination.read_text(encoding='utf-8'))['output']
        u = outputs['Centroid u']['data']
        v = outputs['Centroid v']['data']
        assert len(u) == len(v) == 3
        assert np.all(np.abs(np.diff(u)) > .004)
        assert np.all(np.asarray(outputs['Local wavelength sampling']['data']) > 0)
        centers.append(v)
        np.testing.assert_allclose(outputs['Detected power']['data'], outputs['Optical arrival efficiency']['data'], rtol=1e-12)
        if index == 1:
            exported = tmp_path / 'exported'
            command(repo, 'data', 'export', '--result', result / '1', '--out', exported)
            moved = tmp_path / 'moved-export'
            exported.rename(moved)
            replay = tmp_path / 'replay.json'
            command(repo, 'calculation', 'run', calculations['Centroid u'], '--result', moved, '--out', replay)
            assert json.loads(replay.read_text(encoding='utf-8'))['output'] == outputs['Centroid u']
    assert np.all(np.abs(np.asarray(centers[2]) - centers[0]) > .0003)
