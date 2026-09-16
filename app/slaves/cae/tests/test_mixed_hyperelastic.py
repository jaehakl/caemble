"""Independent differentiation, condensation and equilibrium checks for MINI."""

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from app.methods.continuum.mixed_hyperelastic import mixed_neo_hookean
from app.methods.finite_element.tetrahedron import tetrahedron_quadrature
from app.solvers.structural_mechanics.mixed_solid import prepare_mini, mini_response, condense_bubble
from app.solvers.structural_mechanics.analyses.mixed_static import mixed_static_analysis
from app.solvers.structural_mechanics.loads import follower_pressure
from app.solvers.structural_mechanics.model import Element, StructuralModel
from app.solvers.structural_mechanics.solid_fields import evaluate_solid, inverse_solid, solid_cell_average


POINTS = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]])
MATERIAL = {"model": "mechanics.compressible-neo-hookean@1", "density": 1., "shear": 80., "lame": 110.}


@pytest.mark.parametrize("q", [-35., 125.])
def test_independent_mixed_potential_derivatives(q):
    f = np.array([[1.1, .2, .1], [-.1, .8, .05], [.03, .2, 1.2]])
    response = mixed_neo_hookean(f, q, 80., 110., tangent=True)
    h = 1e-6
    for i, j in np.ndindex(3, 3):
        delta = np.zeros((3, 3)); delta[i, j] = h
        plus, minus = [mixed_neo_hookean(f + sign * delta, q, 80., 110.) for sign in (1, -1)]
        assert (plus.potential - minus.potential) / (2*h) == pytest.approx(response.piola[i, j], rel=1e-6, abs=1e-7)
        np.testing.assert_allclose((plus.piola-minus.piola)/(2*h), response.tangent[:, :, i, j], rtol=1e-6, atol=1e-7)
        assert (plus.volume_residual-minus.volume_residual)/(2*h) == pytest.approx(response.coupling[i, j], abs=1e-8)
    plus, minus = [mixed_neo_hookean(f, q + sign*h, 80., 110.) for sign in (1, -1)]
    assert (plus.potential-minus.potential)/(2*h) == pytest.approx(response.volume_residual, abs=1e-7)
    np.testing.assert_allclose((plus.piola-minus.piola)/(2*h), response.coupling, atol=1e-7)
    assert (plus.volume_residual-minus.volume_residual)/(2*h) == pytest.approx(response.compliance, abs=1e-9)


def test_mini_all_blocks_are_potential_derivatives_and_condense_exactly():
    prepared = prepare_mini(POINTS, MATERIAL)
    rng = np.random.default_rng(71)
    state = rng.normal(size=19) * .008
    state[12:16] *= 1000

    def evaluate(value):
        return mini_response(value[:12].reshape(4, 3), value[12:16], value[16:], MATERIAL, prepared)

    residual, tangent, energy, _ = evaluate(state)
    for index in range(19):
        delta = np.eye(19)[index] * 1e-6
        plus, minus = [evaluate(state + sign*delta) for sign in (1, -1)]
        assert (plus[2][0]-minus[2][0])/2e-6 == pytest.approx(residual[index], rel=1e-6, abs=1e-7)
        np.testing.assert_allclose((plus[0]-minus[0])/2e-6, tangent[:, index], rtol=2e-6, atol=1e-7)
    # Remove rigid modes using independent displacement restraints.
    free = np.r_[[3, 6, 7, 9, 10, 11], np.arange(12, 19)]
    full = np.zeros(19)
    full[free] = np.linalg.solve(tangent[np.ix_(free, free)], -residual[free])
    rhs, matrix, recovery = condense_bubble(residual, tangent)
    retained = free[free < 16]
    reduced = np.zeros(16)
    reduced[retained] = np.linalg.solve(matrix[np.ix_(retained, retained)], -rhs[retained])
    restored = np.r_[reduced, -recovery[:, :16] @ reduced - recovery[:, 16]]
    np.testing.assert_allclose(restored, full, rtol=1e-9, atol=1e-10)


def test_positive_quadrature_refinement_and_rigid_motion():
    values = []
    for order in (5, 7, 9):
        points, weights = tetrahedron_quadrature(order)
        assert np.all(points >= 0) and np.all(weights > 0)
        assert weights.sum() == pytest.approx(1/6)
        data = prepare_mini(POINTS, MATERIAL, order)
        values.append(mini_response(POINTS * [.1, -.1, .05], np.array([10., 20., 30., 40.]), np.array([.005, -.002, .003]), MATERIAL, data))
    for result in values[:-1]:
        for index in (0, 1, 2):
            np.testing.assert_allclose(result[index], values[-1][index], rtol=1e-4, atol=1e-5)
    rotation = Rotation.from_rotvec([.4, -.6, .8]).as_matrix()
    residual, _, energy, stress = mini_response(POINTS @ rotation.T - POINTS + .2, np.zeros(4), np.zeros(3), MATERIAL, data)
    np.testing.assert_allclose(residual, 0, atol=2e-13)
    np.testing.assert_allclose(stress, 0, atol=2e-13)
    np.testing.assert_allclose(energy, 0, atol=2e-13)


def stretch_model(stretch=.8, lame=110.):
    material = {**MATERIAL, "lame": lame}
    fixed = np.array([0, 1, 2, 6, 7, 8, 12, 14, 18, 19])
    model = StructuralModel(np.arange(4), POINTS.copy(), [Element("tet4", np.arange(4), material)],
                            (6*np.arange(4)[:, None]+np.arange(3)).ravel(), fixed, np.zeros((4, 6)))
    model.prescribed = {int(dof): 0. for dof in fixed}
    model.prescribed[6] = stretch-1
    model.solid_formulation = "mixed-mini"
    model.identity = "mini-test-solid"
    return model


@pytest.mark.parametrize("lame", [110., 4e5])
def test_mixed_prescribed_reaction_is_equilibrium_energy_derivative(lame):
    model = stretch_model(lame=lame)
    result = mixed_static_analysis(model)
    energies = [mixed_static_analysis(stretch_model(.8+sign*1e-5, lame)).equilibrium_energy for sign in (1, -1)]
    assert (energies[0]-energies[1])/2e-5 == pytest.approx(result.reaction[1, 0], rel=2e-5)
    assert result.residual < 1e-8
    assert result.time == 0
    assert result.strain_energy == pytest.approx(result.equilibrium_energy, rel=1e-7)


def test_mixed_small_strain_limit_matches_uniaxial_linear_elasticity():
    strain = -1e-5
    result = mixed_static_analysis(stretch_model(1+strain))
    mu, lame = MATERIAL['shear'], MATERIAL['lame']
    young, poisson = mu*(3*lame+2*mu)/(lame+mu), lame/(2*(lame+mu))
    assert result.reaction[1, 0] == pytest.approx(young*strain/6, rel=3e-5)
    assert result.displacement[2, 1] == pytest.approx(-poisson*strain, rel=3e-5)
    assert result.equilibrium_energy == pytest.approx(young*strain**2/12, rel=3e-5)


def test_reaction_energy_derivative_includes_gravity_virtual_work():
    from app.solvers.structural_mechanics.analyses.mixed_static import prepare_mixed
    potentials = []
    for stretch in (.8+1e-5, .8-1e-5, .8):
        model = stretch_model(stretch)
        model.gravity = np.array([0., -8., 4.])
        result = mixed_static_analysis(model)
        prepared = prepare_mixed(model)
        work = prepared['external'] @ result.displacement.ravel() + np.sum(prepared['bubbleExternal']*result.bubble)
        potentials.append(result.equilibrium_energy-work)
    assert (potentials[0]-potentials[1])/2e-5 == pytest.approx(result.reaction[1, 0], rel=2e-5)


def test_displacement_and_mini_follower_equilibrium_agree_for_uniform_strain():
    from app.solvers.structural_mechanics.operators.linear import prepare_matrices
    from app.solvers.structural_mechanics.analyses.static import static_analysis
    model = stretch_model()
    model.follower_pressures = [(np.array([[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]), 12.)]
    mixed = mixed_static_analysis(model)
    model.solid_formulation = 'displacement'
    prepared = prepare_matrices(model)
    displacement = static_analysis(model, prepared, prepared.stiffness, prepared.mass, geometric=True)
    np.testing.assert_allclose(displacement.displacement, mixed.displacement, atol=2e-8)
    np.testing.assert_allclose(displacement.reaction, mixed.reaction, atol=2e-7)
    assert displacement.strain_energy == pytest.approx(mixed.equilibrium_energy, rel=1e-7)


def test_follower_force_tangent_and_closed_surface_resultants():
    model = stretch_model()
    faces = np.array([[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]])
    model.follower_pressures = [(faces, 12.)]
    u = np.zeros((4, 6)); u[:, :3] = POINTS @ np.array([[.1, .3, .1], [0., -.1, .2], [.2, 0., .1]])
    force, matrix = follower_pressure(model, u)
    np.testing.assert_allclose(force.reshape(-1, 6).sum(axis=0), 0, atol=1e-13)
    np.testing.assert_allclose(np.cross(POINTS+u[:, :3], force.reshape(-1, 6)[:, :3]).sum(axis=0), 0, atol=1e-13)
    for dof in model.active:
        delta = np.zeros_like(u); delta.ravel()[dof] = 1e-6
        plus, minus = [follower_pressure(model, u+sign*delta, tangent=False)[0] for sign in (1, -1)]
        np.testing.assert_allclose((plus-minus)/2e-6, matrix[:, dof].toarray().ravel(), atol=2e-9)


def test_bubble_fields_inverse_map_and_reference_volume_average():
    model = stretch_model()
    result = mixed_static_analysis(model)
    result.bubble[0] = [.015, -.01, .008]
    result.auxiliary_pressure[:] = [1., 20., -15., 8.]
    bary = np.array([.1, .2, .3, .4])
    fields = evaluate_solid(model, result, 0, bary)
    expected_u = bary @ result.displacement[:, :3] + 256*np.prod(bary)*result.bubble[0]
    np.testing.assert_allclose(fields['displacement'], expected_u)
    current = bary @ POINTS + fields['displacement']
    affine = POINTS + result.displacement[:, :3]
    natural = np.linalg.solve((affine[1:]-affine[0]).T, current-affine[0])
    initial = np.r_[1-natural.sum(), natural]
    assert np.linalg.norm(initial-bary) > .005
    np.testing.assert_allclose(inverse_solid(model, result, 0, current, initial), bary, atol=1e-10)
    q = bary @ result.auxiliary_pressure
    assert fields['auxiliaryPressure'] == pytest.approx(q)
    assert abs(q-MATERIAL['lame']*np.log(fields['volumeRatio'])) > 1
    direct = mixed_neo_hookean(fields['deformationGradient'], q, 80., 110.)
    np.testing.assert_allclose(fields['cauchyStress'], direct.cauchy)
    points, weights = tetrahedron_quadrature()
    values = evaluate_solid(model, result, 0, points)
    average = solid_cell_average(model, result, 0)
    np.testing.assert_allclose(average['cauchyStress'], np.einsum('g,gij->ij', weights*6, values['cauchyStress']))
    assert np.linalg.norm(values['cauchyStress'].mean(axis=0)-average['cauchyStress']) > .01


def test_gravity_bubble_full_uncondensed_equilibrium_and_energy_gap():
    from scipy.optimize import root
    from app.solvers.structural_mechanics.analyses.mixed_static import prepare_mixed
    model = stretch_model()
    model.gravity = np.array([0., -8., 4.])
    result = mixed_static_analysis(model)
    prepared = prepare_mini(POINTS, MATERIAL)
    external = prepared['bodyWeights'][:, None] * model.gravity
    full_force = np.r_[external[:4].ravel(), np.zeros(4), external[4]]
    free_u = np.flatnonzero(~np.isin((6*np.arange(4)[:, None]+np.arange(3)).ravel(), model.fixed))
    free = np.r_[free_u, np.arange(12, 19)]
    state = np.r_[result.displacement[:, :3].ravel(), np.zeros(7)]

    def equations(unknown):
        state[free] = unknown
        return (mini_response(state[:12].reshape(4, 3), state[12:16], state[16:], MATERIAL, prepared, tangent=False)[0]-full_force)[free]

    solved = root(equations, state[free], tol=1e-10)
    assert solved.success, solved.message
    state[free] = solved.x
    np.testing.assert_allclose(state, np.r_[result.displacement[:, :3].ravel(), result.auxiliary_pressure, result.bubble.ravel()], atol=2e-7)
    assert np.linalg.norm(result.bubble) > 1e-5
    data = prepare_mixed(model)
    bary, weights = tetrahedron_quadrature()
    fields = evaluate_solid(model, result, 0, bary)
    gap = .5*MATERIAL['lame']*np.sum(weights*(np.log(fields['volumeRatio'])-fields['auxiliaryPressure']/MATERIAL['lame'])**2)
    assert result.strain_energy-result.equilibrium_energy == pytest.approx(gap, abs=2e-9)
    np.testing.assert_allclose(data['bubbleExternal'][0], external[4])


def test_failed_mixed_trials_leave_all_accepted_unknowns_unchanged(monkeypatch):
    from app.methods.continuum.hyperelastic import InvalidDeformationError
    from app.solvers.structural_mechanics.analyses import mixed_static
    model = stretch_model()
    model.gravity = np.array([0., -8., 4.])
    expected = mixed_static_analysis(model)
    original = mixed_static.mixed_assembly
    failures = []

    def fail_trial(model, prepared, displacement, q, bubble, factor, *, tangent=True):
        if not tangent and len(failures) < 3:
            failures.append((displacement.copy(), q.copy(), bubble.copy()))
            raise InvalidDeformationError('injected invalid candidate')
        return original(model, prepared, displacement, q, bubble, factor, tangent=tangent)

    monkeypatch.setattr(mixed_static, 'mixed_assembly', fail_trial)
    actual = mixed_static_analysis(model)
    assert len(failures) == 3
    for name in ('displacement', 'auxiliary_pressure', 'bubble', 'reaction'):
        np.testing.assert_allclose(getattr(actual, name), getattr(expected, name), atol=2e-7)
    np.testing.assert_array_equal(model.points, POINTS)


@pytest.mark.asyncio
@pytest.mark.parametrize('change,match', [('zero-lambda', '0 < nu'), ('multiple-materials', 'one frozen'), ('modal', 'static'), ('linear', 'geometricNonlinear')])
async def test_mixed_public_support_matrix_rejects_invalid_settings(monkeypatch, change, match):
    from app.solvers.structural_mechanics import entry
    from tests.test_structural_csg import solid_invocation
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
    from tests.test_structural_csg import solid_invocation
    case = solid_invocation(resolution=.8, second=True)
    case = replace(case, descriptor=solver_catalog.descriptor('structural-mechanics', '7.2.0'))
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


@pytest.mark.parametrize('count', [2, 10000])
def test_mixed_box_observations_and_inline_attachment_roundtrip(count):
    from app.kernel.catalog import solver_catalog
    from app.kernel.transport.tensor import encode_tensor
    from app.solvers.structural_mechanics.outputs.box_grid import build_box_outputs
    from tests.test_catalog_examples import decode_tensor_tree
    from tests.test_box_grid_outputs import grid

    model = stretch_model()
    solution = mixed_static_analysis(model)
    before = tuple(value.copy() for value in (solution.displacement, solution.auxiliary_pressure, solution.bubble))
    descriptor = solver_catalog.descriptor('structural-mechanics', '7.2.0')
    method = 'fea.current-mean-pressure'
    definition = next(item['data'] for item in descriptor['methods']['outputs'] if item['methodId'] == method)
    probe = grid(shape=(count, 1, 1), origin=(-.1, .15, .15), size=(1.2, .01, .01))
    config = {'outputs': [{'methodId': method, 'key': 'pressure', 'parameters': {}, 'boxGrid': {**probe.geometry, 'gridShape': list(probe.shape)}}]}
    value = build_box_outputs(config, descriptor, model, solution)['pressure']
    assert np.any(value['value'] == 0) and np.any(value['value'] != 0)
    encoded, attachments, _ = encode_tensor('pressure', definition, value, 1)
    decoded = decode_tensor_tree(definition, encoded, {item.id: item.data for item in attachments})['']
    np.testing.assert_array_equal(decoded, value['value'])
    assert encoded['boxGrid']['configuration'] == 'current'
    assert definition['unit'] == 'Pa'
    assert bool(attachments) == (count == 10000)
    for actual, expected in zip((solution.displacement, solution.auxiliary_pressure, solution.bubble), before, strict=True):
        np.testing.assert_array_equal(actual, expected)


def test_mini_section_uses_variable_piola_and_deformed_moment_arm():
    from numpy.polynomial.legendre import leggauss
    from app.solvers.structural_mechanics.outputs.box_grid import _box_section_resultant
    from tests.test_box_grid_outputs import grid

    model = stretch_model()
    solution = mixed_static_analysis(model)
    solution.bubble[0] = [.025, -.015, .01]
    solution.auxiliary_pressure[:] = [12., -5., 35., 6.]
    section = .2
    parameters = {'origin': [section, 0., 0.], 'normal': [1., 0., 0.], 'referencePoint': [-.1, .1, -.2]}
    probe = grid(origin=(-1., -1., -1.), size=(3., 3., 3.))
    force, moment = _box_section_resultant(model, solution, probe, parameters)
    a, w = leggauss(20)
    a, w = (a+1)/2, w/2
    r, s = np.meshgrid(a, a, indexing='ij')
    y, z = (1-section)*r, (1-section)*(1-r)*s
    bary = np.column_stack((1-section-y.ravel()-z.ravel(), np.full(r.size, section), y.ravel(), z.ravel()))
    values = evaluate_solid(model, solution, 0, bary)
    traction = values['firstPiolaStress'][:, :, 0]
    weights = (w[:, None]*w[None, :]*(1-r)*(1-section)**2).ravel()
    expected_force = weights @ traction
    expected_moment = weights @ np.cross(bary @ POINTS + values['displacement']-parameters['referencePoint'], traction)
    np.testing.assert_allclose(force, expected_force, rtol=1e-4, atol=1e-5)
    np.testing.assert_allclose(moment, expected_moment, rtol=1e-4, atol=1e-5)
