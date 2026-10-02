"""Explicit product entry checks, excluded from low-cost collection."""
import numpy as np
import pytest
from app.solvers.structural_mechanics.model import Element
from tests.mixed_hyperelastic_fixtures import stretch_model


@pytest.mark.asyncio
@pytest.mark.parametrize('change,match', [('zero-lambda', '0 < nu'), ('multiple-materials', 'one frozen'), ('modal', 'static'), ('linear', 'geometricNonlinear')])
async def test_mixed_public_support_matrix_rejects_invalid_settings(monkeypatch, change, match):
    from app.solvers.structural_mechanics import entry
    from tests.structural_fixture import solid_invocation
    case = solid_invocation()
    case.config['parameters'].update(solidFormulation='mixed-mini', geometricNonlinear=change != 'linear', analysis='modal' if change == 'modal' else 'static')
    model = stretch_model()
    model.elements[0].material['identity'] = ('experiment', 'one')
    if change == 'zero-lambda':
        model.elements[0].material['lame'] = 0
    if change == 'multiple-materials':
        model.elements.append(Element('tet4', np.arange(4), {**model.elements[0].material, 'identity': ('experiment', 'two')}))

    async def geometry(_invocation):
        return model

    monkeypatch.setattr(entry, 'build_geometry_model', geometry)
    with pytest.raises(ValueError, match=match):
        await entry.run(case)


@pytest.mark.asyncio
async def test_two_geometry_roots_can_share_one_frozen_mixed_material():
    from dataclasses import replace
    from app.kernel.catalog import solver_catalog
    from app.solvers.structural_mechanics import entry
    from tests.structural_fixture import solid_invocation
    case = solid_invocation(resolution=.8, second=True)
    case = replace(case, descriptor=solver_catalog.descriptor('structural-mechanics', '8.0.0'))
    case.config['parameters'].update(solidFormulation='mixed-mini', geometricNonlinear=True)
    case.config['initializations'].append({'methodId': 'fea.bonded', 'target': ['experiment.geometry.all'], 'parameters': {}})
    selected = case.world['materials']['experiment']['Steel']['models']['solid']
    selected['model'] = 'mechanics.compressible-neo-hookean@1'
    selected['parameters'].update(E=2980., nu=.49, density=1000.)
    case.config['boundaryConditions'][1]['parameters']['force'] = [1., 0., 0.]
    result = await entry.run(case)
    assert result.observations['strainEnergy'] > 0
    assert result.observations['relativeResidual'] < 1e-9
    assert result.observations['time'] == 0
