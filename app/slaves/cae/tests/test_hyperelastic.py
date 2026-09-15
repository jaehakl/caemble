"""Independent material/element derivatives, equilibrium and passive observations."""

from copy import deepcopy

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from app.methods.continuum.hyperelastic import InvalidDeformationError, neo_hookean
from app.solvers.structural_mechanics.hyperelastic import prepare_tet4, tet4_response
from app.solvers.structural_mechanics.materials import isotropic_elasticity
from app.solvers.structural_mechanics.continuum import element_matrices
from app.solvers.structural_mechanics.model import StructuralModel, Element
from app.solvers.structural_mechanics.operators.linear import prepare_matrices
from app.solvers.structural_mechanics.analyses.static import static_analysis
from app.solvers.mpm.observation import observe, interpolate
from app.solvers.mpm.formulation import stable_timestep


POINTS = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]])
MATERIAL = {"model": "mechanics.compressible-neo-hookean@1", "density": 1000., "shear": 80., "lame": 110.}


@pytest.mark.parametrize("deformation", [np.diag([.7, 1.2, .9]), np.array([[1., .4, .1], [.2, 1.3, .1], [0., -.2, .8]])])
def test_material_energy_stress_and_tangent_have_independent_derivatives(deformation):
    response = neo_hookean(deformation, 80., 110., tangent=True)
    derivative = np.empty((3, 3, 3, 3))
    for k, l in np.ndindex(3, 3):
        delta = np.zeros((3, 3)); delta[k, l] = 1e-6
        plus, minus = [neo_hookean(deformation + sign * delta, 80., 110.) for sign in (1, -1)]
        assert (plus.energy - minus.energy) / 2e-6 == pytest.approx(response.piola[k, l], rel=2e-7, abs=2e-7)
        derivative[:, :, k, l] = (plus.piola - minus.piola) / 2e-6
    np.testing.assert_allclose(response.tangent, derivative, rtol=2e-7, atol=2e-7)
    np.testing.assert_allclose(response.tangent, response.tangent.transpose(2, 3, 0, 1), atol=1e-12)
    assert neo_hookean(deformation, 80., 110.).tangent is None


def test_tet_internal_force_and_tangent_are_energy_derivatives():
    prepared = prepare_tet4(POINTS, MATERIAL)
    displacement = POINTS @ np.array([[-.2, .1, .03], [0., .1, -.05], [0., .02, .1]])
    force, tangent, _, _ = tet4_response(displacement, MATERIAL, prepared)
    for index in range(12):
        delta = np.zeros((4, 3)); delta.ravel()[index] = 1e-6
        plus, minus = [tet4_response(displacement + sign * delta, MATERIAL, prepared) for sign in (1, -1)]
        assert (plus[2] - minus[2]) / 2e-6 == pytest.approx(force[index], rel=2e-7, abs=2e-7)
        np.testing.assert_allclose((plus[0] - minus[0]) / 2e-6, tangent[:, index], rtol=2e-7, atol=2e-7)
    rotation = Rotation.from_rotvec([.8, -.6, 1.2]).as_matrix()
    rigid = POINTS @ rotation.T + [.2, .3, .4] - POINTS
    force, _, energy, stress = tet4_response(rigid, MATERIAL, prepared)
    np.testing.assert_allclose(force, 0., atol=1e-12)
    np.testing.assert_allclose(stress, 0., atol=1e-12)
    assert energy == pytest.approx(0, abs=1e-12)
    young = 80 * (3 * 110 + 2 * 80) / (110 + 80)
    poisson = 110 / (2 * (110 + 80))
    linear, mass = element_matrices("tet4", POINTS, isotropic_elasticity(young, poisson), 1000)
    np.testing.assert_allclose(prepared["K"], linear, atol=1e-12)
    np.testing.assert_allclose(prepared["M"], mass, atol=1e-12)


@pytest.mark.parametrize("stretch", [.7, 1.5])
def test_prescribed_stretch_reaction_matches_energy_and_free_lateral_equilibrium(stretch):
    model = StructuralModel(np.arange(4), POINTS.copy(), [Element("tet4", np.arange(4), MATERIAL)],
                            (6 * np.arange(4)[:, None] + np.arange(3)).ravel(),
                            np.array([0, 1, 2, 6, 7, 8, 12, 14, 18, 19]), np.zeros((4, 6)))
    model.prescribed = {int(dof): 0. for dof in model.fixed}
    model.prescribed[6] = stretch - 1
    before = deepcopy(model)
    prepared = prepare_matrices(model)
    solution = static_analysis(model, prepared, prepared.stiffness, prepared.mass, geometric=True)
    assert solution.displacement[1, 0] == stretch - 1
    response = neo_hookean(np.eye(3) + solution.displacement[:, :3].T @ prepared.element_data[0]["gradients"], 80, 110)
    np.testing.assert_allclose(response.piola[[1, 2], [1, 2]], 0, atol=1e-6)
    assert solution.reaction[1, 0] == pytest.approx(response.piola[0, 0] / 6, rel=1e-7)
    step = 1e-5
    energies = []
    for sign in (1, -1):
        model.prescribed[6] = stretch - 1 + sign * step
        energies.append(static_analysis(model, prepared, prepared.stiffness, prepared.mass, geometric=True).strain_energy)
    assert (energies[0] - energies[1]) / (2 * step) == pytest.approx(solution.reaction[1, 0], rel=2e-6)
    np.testing.assert_array_equal(model.points, before.points)
    assert solution.time == 0


def test_material_domain_failure_and_passive_rotation_interpolation():
    invalid = np.diag([-1., 1., 1.]); before = invalid.copy()
    with pytest.raises(InvalidDeformationError):
        neo_hookean(invalid, 80., 110.)
    np.testing.assert_array_equal(invalid, before)
    model = {"settings": {"shear": 80., "lame": 110., "density": 1000.}, "referencePositions": np.zeros((1, 3))}
    state = {"positions": np.ones((1, 3)), "velocity": np.zeros((1, 3)), "deformationGradient": np.eye(3)[None]}
    first = observe(state, model)
    state["deformationGradient"] = (Rotation.from_rotvec([0, 0, np.pi]).as_matrix() @ np.diag([.7, 1.2, 1.]))[None]
    last = observe(state, model)
    middle = interpolate(first, last, .5, model)
    assert middle["volumeRatio"][0] > 0
    response = neo_hookean(middle["deformationGradient"], 80., 110.)
    np.testing.assert_allclose(middle["stress"], response.cauchy)
    np.testing.assert_allclose(middle["density"] * middle["volumeRatio"], 1000.)
    np.testing.assert_allclose(middle["strainEnergyDensity"], response.energy)
    assert interpolate(first, last, 0, model) is first
    assert interpolate(first, last, 1, model) is last
    settings = {**model["settings"], "spacing": .1}
    undeformed = stable_timestep(state["velocity"], np.eye(3)[None], settings)
    compressed = stable_timestep(state["velocity"], (.4 * np.eye(3))[None], settings)
    assert compressed < undeformed


def test_mpm_reference_and_current_observations_use_material_volume_and_empty_cells():
    from app.kernel.catalog import solver_catalog
    from app.solvers.mpm.outputs import build_outputs

    model = {"referencePositions": np.array([[.1, .1, .1], [.2, .1, .1]]),
             "referenceVolume": np.array([1., 3.]), "mass": np.array([2., 6.])}
    samples = {"times": np.array([0.]), "positions": np.array([[[.2, .1, .1], [.3, .1, .1]]]),
               "volumeRatio": np.array([[2., .5]]), "displacement": np.array([[[1., 0, 0], [3., 0, 0]]]),
               "strainEnergyDensity": np.array([[4., 10.]]), "velocity": np.array([[[1., 0, 0], [2., 0, 0]]])}
    box = {"origin": [0, 0, 0], "size": [1, 1, 1], "rotation": np.eye(3).tolist(),
           "gridShape": [2, 1, 1], "lengthUnit": "m", "source": "task", "rootId": "probe"}
    config = {"outputs": [{"methodId": method, "key": key, "parameters": {}, "boxGrid": box}
                          for key, method in (("ref", "mpm.reference-displacement"), ("cur", "mpm.displacement"))]}
    descriptor = solver_catalog.descriptor("mpm", "2.0.0")
    result = build_outputs(config, descriptor, model, samples)
    assert result["ref"]["value"].ravel()[0] == pytest.approx(2.5)
    assert result["cur"]["value"].ravel()[0] == pytest.approx((2 * 1 + 1.5 * 3) / 3.5)
    for artifact in result.values():
        np.testing.assert_array_equal(artifact["value"][1], 0)
        assert artifact["boxGrid"]["weighting"] == "material-volume"
    config["outputs"] = [{"methodId": "mpm.strain-energy", "key": "energy", "parameters": {},
                          "boxGrid": {**box, "gridShape": [1, 1, 1], "origin": [10, 10, 10]}}]
    assert build_outputs(config, descriptor, model, samples)["energy"]["value"].item() == 34


def test_material_coefficients_are_input_errors_and_failed_fem_trials_roll_back(monkeypatch):
    from app.solvers.structural_mechanics.analyses import static

    with pytest.raises(ValueError) as failure:
        neo_hookean(np.eye(3), 80., np.nan)
    assert not isinstance(failure.value, InvalidDeformationError)
    model = StructuralModel(np.arange(4), POINTS.copy(), [Element("tet4", np.arange(4), MATERIAL)],
                            (6 * np.arange(4)[:, None] + np.arange(3)).ravel(),
                            np.array([0, 1, 2, 6, 7, 8, 12, 14, 18, 19]), np.zeros((4, 6)))
    model.prescribed = {int(dof): 0. for dof in model.fixed}
    model.prescribed[6] = -.3
    prepared = prepare_matrices(model)
    baseline = static_analysis(model, prepared, prepared.stiffness, prepared.mass, geometric=True)
    original, trials = static.structural_response, []

    def reject_first(model, displacement, *args, **kwargs):
        trials.append(displacement.copy())
        result = original(model, displacement, *args, **kwargs)
        if len(trials) == 1:
            raise InvalidDeformationError("invalid initial trial")
        return result

    monkeypatch.setattr(static, "structural_response", reject_first)
    actual = static_analysis(model, prepared, prepared.stiffness, prepared.mass, geometric=True)
    assert trials[1][1, 0] == trials[0][1, 0] / 2
    np.testing.assert_array_equal(trials[1][[2, 3]], 0)
    np.testing.assert_allclose(actual.displacement, baseline.displacement, atol=1e-8)
    np.testing.assert_allclose(actual.reaction, baseline.reaction, atol=1e-6)


@pytest.mark.asyncio
@pytest.mark.parametrize("change,match", [
    ("linear", "geometricNonlinear"), ("transient", "static analysis"), ("modal", "static analysis"),
    ("mixed", "cannot be mixed"), ("contact", "without contact"), ("link", "without contact"),
])
async def test_unsupported_fem_material_combinations_are_rejected_before_assembly(monkeypatch, change, match):
    from app.solvers.structural_mechanics import entry
    from tests.test_structural_csg import solid_invocation

    case = solid_invocation()
    case.config["parameters"]["geometricNonlinear"] = change != "linear"
    if change in {"transient", "modal"}:
        case.config["parameters"]["analysis"] = change
    model = StructuralModel(np.arange(4), POINTS.copy(), [Element("tet4", np.arange(4), MATERIAL)],
                            (6 * np.arange(4)[:, None] + np.arange(3)).ravel(), np.array([], dtype=int), np.zeros((4, 6)))
    if change == "mixed":
        model.elements.append(Element("tet4", np.arange(4), {"model": "mechanics.isotropic-elastic@1"}))
    if change == "contact":
        model.contacts.append({})
    if change == "link":
        model.links.append((0, 1, np.arange(3)))

    async def geometry_model(_invocation):
        return model

    monkeypatch.setattr(entry, "build_geometry_model", geometry_model)
    with pytest.raises(ValueError, match=match):
        await entry.run(case)


@pytest.mark.asyncio
@pytest.mark.parametrize("fixed", [True, False])
async def test_conflicting_surface_prescriptions_are_rejected(fixed):
    from app.solvers.structural_mechanics.domain import build_geometry_model
    from tests.test_structural_csg import solid_invocation

    case = solid_invocation()
    target = ["experiment.surface.body-left"]
    if not fixed:
        case.config["boundaryConditions"][0] = {"methodId": "fea.prescribed-displacement", "target": target,
                                              "parameters": {"components": ["x"], "displacement": [.1, 0, 0]}}
    case.config["boundaryConditions"].append({"methodId": "fea.prescribed-displacement", "target": target,
                                            "parameters": {"components": ["x"], "displacement": [.2, 0, 0]}})
    with pytest.raises(ValueError, match="conflicting prescribed"):
        await build_geometry_model(case)


def test_large_apic_compression_rejects_inversion_and_accepts_a_smaller_step():
    from app.solvers.mpm.formulation import step

    positions = np.array([[.5, .5, .5]])
    velocity, deformation = np.zeros((1, 3)), np.eye(3)[None]
    affine = np.diag([-2000., 0, 0])[None]
    settings = {"origin": np.zeros(3), "spacing": .1, "shape": (11, 11, 11), "density": 1000.,
                "shear": 80., "lame": 110., "gravity": np.zeros(3), "fixedNodes": []}
    before = [value.copy() for value in (positions, velocity, deformation, affine)]
    with pytest.raises(InvalidDeformationError):
        step(positions, velocity, deformation, affine, np.ones(1), np.full(1, .001), settings, .001)
    candidate = step(positions, velocity, deformation, affine, np.ones(1), np.full(1, .001), settings, .00025)
    assert np.linalg.det(candidate[2]).item() == pytest.approx(.5)
    for value, original in zip((positions, velocity, deformation, affine), before):
        np.testing.assert_array_equal(value, original)


@pytest.mark.asyncio
async def test_prescribed_displacement_rejects_a_dependent_attachment_surface():
    from app.solvers.structural_mechanics.domain import build_geometry_model
    from tests.test_structural_csg import solid_invocation

    case = solid_invocation()
    target = ["experiment.surface.body-right"]
    case.config["initializations"].append({"methodId": "fea.translation-spring", "target": target,
                                         "parameters": {"axisA": "x", "axisB": "x", "ratio": 1., "stiffness": 100., "damping": 0.}})
    case.config["boundaryConditions"].append({"methodId": "fea.prescribed-displacement", "target": target,
                                            "parameters": {"components": ["x"], "displacement": [.1, 0, 0]}})
    with pytest.raises(ValueError, match="dependent attachment"):
        await build_geometry_model(case)
