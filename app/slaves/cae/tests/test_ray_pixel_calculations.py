"""Catalog Calculation definitions evaluated against hand-computable Records."""
import json
from pathlib import Path
import subprocess

import numpy as np
from caemble_catalog import open_catalog


def test_catalog_pixel_calculations_and_no_signal_diagnostics(tmp_path):
    repo = Path(__file__).resolve().parents[4]
    with open_catalog() as catalog:
        definitions = catalog.experiment('pixel-monochromatic-response')['calculations']
        methods = {item['methodId']: item['data'] for item in catalog.get_solver_manifest('ray-tracing', '4.1.0')['descriptor']['methods']['outputs']}
    geometry = {'origin': [0, 0, -.1], 'size': [2, 2, .2], 'rotation': np.eye(3).tolist(), 'lengthUnit': 'm',
                'gridShape': [2, 2, 1], 'source': 'experiment', 'rootId': 'sensor'}
    axes = [{'name': name, 'ticks': ticks, **({'unit': unit} if unit else {})} for name,ticks,unit in
            [('x',[.5,1.5],'m'),('y',[.5,1.5],'m'),('z',[.1],'m'),('time',[0],'s'),
             ('frequency',[299792458/600e-9,299792458/500e-9],'Hz'),('amplitudePhase',['value'],None),('component',['value'],None)]]
    signal = {'dtype':'float64', 'tensorOrder':0, 'quantityKind':'optics.RadiantFlux', 'unit':'W',
              'shape':[2,2,1,1,2,1,1], 'data':[1,0,0,2,0,0,3,2], 'axes':axes,
              'boxGrid':{**geometry, **methods['ray.detector-power']['boxGrid']}}
    launched = {**signal, 'shape':[1,1,1,1,2,1,1], 'data':[8,4],
                'axes':[dict(axes[0],ticks=[1]),dict(axes[1],ticks=[1]),*axes[2:]],
                'boxGrid':{**geometry,'gridShape':[1,1,1],**methods['ray.launched-power']['boxGrid']}}
    expected = {'Detected power':[4,4], 'Optical arrival efficiency':[1,.5],
                'Power profile u':[2,1,2,3], 'Power profile v':[0,1,4,3],
                'Centroid u':[1,1.25], 'Centroid v':[1.5,1.25], 'Local wavelength sampling':[400]}
    for zero in (False,True):
        fixture = tmp_path / f'input-{zero}.json'
        fixture.write_text(json.dumps({'detectorPower':{**signal,'data':[0]*8 if zero else signal['data']},'launchedPower':launched}),encoding='utf-8')
        for index,definition in enumerate(definitions):
            source = tmp_path / f'calculation-{index}.js'
            source.write_text(definition['source_code'],encoding='utf-8')
            output = tmp_path / f'output-{zero}-{index}.json'
            completed = subprocess.run(['node',str(repo/'app/ui/dist-cli/caemble.cjs'),'--repo',str(repo),'calculation','run',str(source),
                                        '--fixture',str(fixture),'--out',str(output)],cwd=repo,capture_output=True,text=True,encoding='utf-8',timeout=30)
            invalid = zero and definition['name'] in {'Centroid u','Centroid v','Local wavelength sampling'}
            assert (completed.returncode != 0) == invalid, completed.stdout + completed.stderr
            if not invalid:
                result = json.loads(output.read_text(encoding='utf-8'))['output']
                values = expected[definition['name']]
                np.testing.assert_allclose(result['data'], [0]*len(values) if zero else values, rtol=1e-12)
