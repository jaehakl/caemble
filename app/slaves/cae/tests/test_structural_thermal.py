"""Thermal eigenstrain benchmarks independent of the electrical/heat solvers."""

from dataclasses import replace

import numpy as np
import pytest

from app.kernel.api import FieldValue
from app.methods.coupling.assembly import transfer_assembly_nodal_field
from app.methods.geometry import GeometryService
from app.methods.mesh.models import VolumeMeshingProfile
from app.methods.mesh.subdomain import VolumeSubdomain, build_volume_subdomain
from app.solvers.structural_mechanics.analyses.static import static_analysis
from app.solvers.structural_mechanics.materials import isotropic_elasticity
from app.solvers.structural_mechanics.meshing import brick_mesh
from app.solvers.structural_mechanics.model import Element, StructuralModel
from app.solvers.structural_mechanics.operators.linear import prepare_matrices
from app.solvers.structural_mechanics.thermal import prepare_thermal_force, thermal_element_response, thermal_stress_at
from tests.test_scalar_fem import layered_scene
from app.methods.fields.box_grid import BoxGrid
from app.solvers.structural_mechanics.outputs.thermal import surface_displacement_metrics, rms_von_mises_stress, thermal_section_resultant


def thermal_brick(divisions=(3, 2, 2), size=(1., .2, .1), young=2e9, poisson=.3):
    points, bricks = brick_mesh([0, 0, 0], size, divisions)
    split = np.array([[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6],
                      [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]])
    cells = bricks[:, split].reshape(-1, 4)
    material = {"model": "mechanics.isotropic-elastic@1", "E": young, "nu": poisson,
                "density": 1000., "C": isotropic_elasticity(young, poisson)}
    elements = [Element("tet4", nodes, material) for nodes in cells]
    active = (6 * np.arange(len(points))[:, None] + np.arange(3)).ravel()
    # Roller symmetry planes remove rigid motion while allowing exact free expansion.
    fixed = np.concatenate([6 * np.flatnonzero(points[:, axis] == 0) + axis for axis in range(3)])
    return StructuralModel(np.arange(len(points)), points, elements, active, fixed, np.zeros((len(points), 6)))


def solve_thermal(model):
    prepared = prepare_matrices(model)
    prepare_thermal_force(model, prepared)
    return static_analysis(model, prepared, prepared.stiffness, prepared.mass)


@pytest.mark.parametrize("scale", [1., 1e-6])
def test_free_uniform_expansion_is_stress_free_at_macro_and_micro_scales(scale):
    model = thermal_brick(size=np.array([1., .2, .1]) * scale)
    strain = 1e-5 * 40
    model.thermal_strain = np.full((len(model.elements), 4), strain)
    solution = solve_thermal(model)
    np.testing.assert_allclose(solution.displacement[:, :3], model.points * strain, rtol=1e-9, atol=scale * 1e-14)
    np.testing.assert_allclose(solution.stresses, 0., atol=2e9 * strain * 1e-8)
    np.testing.assert_allclose(solution.reaction, 0., atol=2e9 * strain * scale**2 * 1e-8)
    assert solution.strain_energy < 2e9 * strain**2 * scale**3 * 1e-16
    assert solution.residual < 1e-8


def test_uniaxially_constrained_expansion_reaction_and_energy():
    model = thermal_brick()
    tip = np.flatnonzero(model.points[:, 0] == 1.)
    model.fixed = np.unique(np.r_[model.fixed, 6 * tip])
    strain, young, poisson = 4e-4, 2e9, .3
    model.thermal_strain = np.full((len(model.elements), 4), strain)
    solution = solve_thermal(model)
    expected = model.points * strain * (1 + poisson)
    expected[:, 0] = 0
    np.testing.assert_allclose(solution.displacement[:, :3], expected, atol=1e-12)
    np.testing.assert_allclose(np.asarray(solution.stresses), np.broadcast_to([-young * strain, 0, 0, 0, 0, 0], np.asarray(solution.stresses).shape), atol=1e-6)
    assert solution.reaction[tip, 0].sum() == pytest.approx(-young * strain * .02, rel=1e-6)
    assert solution.strain_energy == pytest.approx(.5 * young * strain**2 * .02, rel=1e-6)
    grid = BoxGrid({"origin": [.2, .02, .01], "size": [.6, .16, .08], "rotation": np.eye(3),
                    "lengthUnit": "m", "gridShape": [1, 1, 1], "source": "task", "rootId": "probe"})
    assert rms_von_mises_stress(model, solution, grid) == pytest.approx(young * strain, rel=1e-6)
    whole = BoxGrid({**grid.geometry, "origin": [0, 0, 0], "size": [1, .2, .1], "gridShape": [1, 1, 1]})
    assert rms_von_mises_stress(model, solution, whole) == pytest.approx(young * strain, rel=1e-6)
    cut_force, _ = thermal_section_resultant(model, solution, grid, {"origin": [.5, 0, 0], "normal": [1, 0, 0], "referencePoint": [.5, .1, .05]})
    np.testing.assert_allclose(cut_force, [-young * strain * .16 * .08, 0, 0], atol=1e-6)


@pytest.mark.parametrize("supports", [[], [0, 1, 2], [0, 1, 2, 6, 7, 8]])
def test_thermal_equilibrium_rejects_unconstrained_rigid_motion(supports):
    model = thermal_brick()
    model.fixed = np.asarray(supports, dtype=int)
    model.thermal_strain = np.full((len(model.elements), 4), 4e-4)
    with pytest.raises(ValueError, match="remove all rigid motions"):
        solve_thermal(model)


def test_positive_definite_factorization_rejects_indefinite_system_without_changing_default():
    from app.methods.linalg.direct import solve_sparse
    matrix = np.diag([-2., 3.])
    np.testing.assert_allclose(solve_sparse(matrix, np.ones(2)), [-.5, 1 / 3])
    with pytest.raises(ValueError, match="not positive definite"):
        solve_sparse(matrix, np.ones(2), ordering="MMD_AT_PLUS_A", positive_definite=True)


def test_surface_warpage_removes_area_weighted_tilt_without_grid_sampling():
    from types import SimpleNamespace
    model = thermal_brick(divisions=(4, 2, 2))
    displacement = np.zeros_like(model.force)
    displacement[:, 2] = .01 * model.points[:, 0] + .03 * model.points[:, 1] + .2
    solution = SimpleNamespace(displacement=displacement)
    geometry = {"origin": [0, 0, 0], "size": [1, .2, .1], "rotation": np.eye(3),
                "lengthUnit": "m", "source": "task", "rootId": "surface"}
    parameters = {"origin": [0, 0, .1], "normal": [0, 0, 1]}
    for shape in ([1, 1, 1], [20, 11, 3]):
        grid = BoxGrid({**geometry, "gridShape": shape})
        maximum, warpage = surface_displacement_metrics(model, solution, grid, parameters)
        assert maximum == pytest.approx(.216, rel=1e-12)
        assert warpage < 1e-13
    displacement[:, 2] += .002 * model.points[:, 0]**2
    maximum, warpage = surface_displacement_metrics(model, solution, grid, parameters)
    assert maximum == pytest.approx(.218, rel=1e-12)
    assert warpage == pytest.approx(.0005, rel=1e-10)


def test_nonuniform_temperature_force_is_energy_derivative_and_stress_is_affine():
    model = thermal_brick(divisions=(1, 1, 1))
    element = model.elements[0]
    points, elasticity = model.points[element.nodes], element.material["C"]
    rng = np.random.default_rng(41)
    displacement = rng.normal(size=12) * 1e-5
    eigenstrain = points @ [1e-4, -3e-4, 2e-4]
    force, stress, energy = thermal_element_response(points, displacement, elasticity, eigenstrain)
    direction = rng.normal(size=12)
    step = 1e-9
    energies = [thermal_element_response(points, displacement + sign * step * direction, elasticity, eigenstrain)[2] for sign in (-1, 1)]
    assert (energies[1] - energies[0]) / (2 * step) == pytest.approx(force @ direction, rel=1e-6)
    # Replacing the varying eigenstrain by its average loses stored energy.
    averaged = thermal_element_response(points, displacement, elasticity, np.full(4, eigenstrain.mean()))[2]
    assert energy > averaged
    model.thermal_strain = np.zeros((len(model.elements), 4))
    model.thermal_strain[0] = eigenstrain
    from types import SimpleNamespace
    sampled = thermal_stress_at(model, SimpleNamespace(stresses=[stress]), 0, np.eye(4))
    np.testing.assert_allclose(sampled[1] - sampled[0], -(eigenstrain[1] - eigenstrain[0]) * elasticity[:, :3].sum(axis=1))


def test_batched_orthotropic_thermal_response_matches_element_quadrature():
    from app.solvers.structural_mechanics.materials import orthotropic_elasticity
    from app.solvers.structural_mechanics.operators.internal import structural_response

    model = thermal_brick(divisions=(2, 1, 1))
    elasticity = orthotropic_elasticity(2e9, 3e9, 4e9, .2, .25, .15, .8e9, 1e9, 1.2e9)
    for element in model.elements:
        element.material = {**element.material, "model": "mechanics.orthotropic-elastic@1", "C": elasticity}
    model.thermal_strain = np.asarray([model.points[element.nodes] @ [1e-4, -2e-4, 3e-4] for element in model.elements])
    displacement = np.random.default_rng(37).normal(size=model.force.shape) * 1e-5
    prepared = prepare_matrices(model)
    force, _, _, stress, energy = structural_response(model, displacement, None, prepared, None)
    expected_force, expected_energy = np.zeros(model.size), 0.
    for index, element in enumerate(model.elements):
        element_force, element_stress, element_energy = thermal_element_response(
            model.points[element.nodes], displacement[element.nodes, :3], elasticity, model.thermal_strain[index])
        dofs = (6 * element.nodes[:, None] + np.arange(3)).ravel()
        np.add.at(expected_force, dofs, element_force)
        expected_energy += element_energy
        np.testing.assert_allclose(stress[index], element_stress, rtol=1e-12, atol=1e-8)
    np.testing.assert_allclose(force, expected_force, rtol=1e-12, atol=1e-8)
    assert energy == pytest.approx(expected_energy, rel=1e-12)
    from app.solvers.structural_mechanics.continuum import physical_orientation_matrices
    model.physical_node_count = len(model.points)
    frames = np.tile(np.eye(3), (len(model.points), 1, 1))
    batched_frames = physical_orientation_matrices(model, displacement, frames)
    reference_frames = physical_orientation_matrices(replace(model, thermal_strain=None), displacement, frames)
    np.testing.assert_allclose(batched_frames, reference_frames, atol=1e-14)


def test_box_stress_uses_point_temperature_and_native_stress_uses_volume_average():
    from app.kernel.catalog import SolverCatalog
    from app.solvers.structural_mechanics.outputs.box_grid import build_box_outputs
    from app.solvers.structural_mechanics.outputs.fields import _tet_stress
    from app.solvers.structural_mechanics.state import initial_solution

    points = np.array([[0., 0, 0], [1., 0, 0], [0., 1, 0], [0., 0, 1]])
    material = {"model": "mechanics.isotropic-elastic@1", "C": isotropic_elasticity(2e9, .3)}
    model = StructuralModel(np.arange(4), points, [Element("tet4", np.arange(4), material)],
                            np.arange(24), np.arange(24), np.zeros((4, 6)), identity="thermal-point-sampling")
    model.thermal_strain = np.array([[0, 1e-4, 0, 0]])
    solution = initial_solution(model)
    solution.stresses = [thermal_element_response(points, np.zeros(12), material["C"], model.thermal_strain[0])[1]]
    grid = {"origin": [0, 0, 0], "size": [.2, .2, .2], "rotation": np.eye(3),
            "lengthUnit": "m", "gridShape": [2, 1, 1], "source": "task", "rootId": "probe"}
    descriptor = SolverCatalog.discover().descriptor("structural-mechanics", "7.2.0")
    output = build_box_outputs({"outputs": [{"key": "stress", "methodId": "fea.stress-field", "boxGrid": grid}]},
                               descriptor, model, solution)["stress"]["value"]
    values = np.asarray(output).reshape(2, 6)
    expected = np.zeros((2, 6))
    expected[:, :3] = (-2e9 / (1 - .6) * 1e-4 * np.array([.05, .15]))[:, None]
    np.testing.assert_allclose(values, expected, rtol=1e-12, atol=1e-9)
    np.testing.assert_allclose(_tet_stress(model, solution, 0), np.eye(3) * (-2e9 / (1 - .6) * 1e-4 * .25))


@pytest.mark.asyncio
async def test_thermal_configuration_requires_paired_explicit_supported_inputs():
    from copy import deepcopy
    from types import SimpleNamespace
    from app.solvers.structural_mechanics.domain import build_geometry_model
    from app.solvers.structural_mechanics.thermal import configure_thermal_expansion
    from tests.test_structural_csg import solid_invocation

    invocation = solid_invocation()
    target = ["experiment.geometry.all"]
    invocation.config["initializations"].extend([
        {"methodId": "fea.mesh", "target": target, "parameters": {}},
        {"methodId": "fea.thermal-expansion", "target": target, "parameters": {"stressFreeTemperature": 300.}},
    ])
    model = await build_geometry_model(invocation)
    field = FieldValue(model.assembly_domain, "node", "thermodynamics.Temperature", "K", np.full(len(model.points), 300.))
    invocation = replace(invocation, inputs={"temperature": SimpleNamespace(value=field)})
    with pytest.raises(ValueError, match="explicitly selected"):
        configure_thermal_expansion(invocation, model)
    invocation.world["materials"]["experiment"]["Steel"]["models"]["expansion"] = {
        "model": "mechanics.isotropic-thermal-expansion@1", "parameters": {"alpha": 1e-5}}
    invocation.world["materialSelections"]["thermalExpansionDomain"] = {"Steel": {"expansion": "expansion"}}
    configure_thermal_expansion(invocation, model)
    # Remove this fixture's mechanical load to test exactly zero thermal loading.
    model.force[:] = 0
    result = solve_thermal(model)
    assert not result.displacement.any() and result.strain_energy == 0 and result.residual == 0
    with pytest.raises(ValueError, match="used together"):
        configure_thermal_expansion(replace(invocation, inputs={}), model)
    without_rule = deepcopy(invocation.config)
    without_rule["initializations"] = without_rule["initializations"][:-1]
    with pytest.raises(ValueError, match="used together"):
        configure_thermal_expansion(replace(invocation, config=without_rule), model)
    for change in ({"analysis": "modal"}, {"analysis": "harmonic"}, {"analysis": "buckling"},
                   {"analysis": "transient"}, {"geometricNonlinear": True}):
        config = deepcopy(invocation.config)
        config["parameters"].update(change)
        with pytest.raises(ValueError, match="static small-strain"):
            configure_thermal_expansion(replace(invocation, config=config), model)
    for attribute, value in (("contacts", [{}]), ("solid_formulation", "mixed-mini")):
        with pytest.raises(ValueError, match="static small-strain"):
            configure_thermal_expansion(invocation, replace(model, **{attribute: value}))
    model.elements[0].material["model"] = "mechanics.j2-plasticity@1"
    with pytest.raises(ValueError, match="static small-strain"):
        configure_thermal_expansion(invocation, model)


def test_bimaterial_strip_bending_converges_to_independent_laminate_section(record_property):
    length, width, thickness = 2., .04, .2
    young, strain = [1e9, 2e9], [2e-4, 4e-4]
    section, thermal = np.zeros((2, 2)), np.zeros(2)
    for modulus, expansion, low, high in zip(young, strain, [0, .1], [.1, .2], strict=True):
        moments = np.array([high - low, (high**2 - low**2) / 2, (high**3 - low**3) / 3])
        section += modulus * np.array([[moments[0], moments[1]], [moments[1], moments[2]]])
        thermal += modulus * expansion * moments[:2]
    _, curvature = np.linalg.solve(section, thermal)
    expected = -curvature * length**2 / 2
    errors = []
    for nx, nz in ((48, 8), (96, 16), (144, 24)):
        model = thermal_brick(divisions=(nx, 2, nz), size=(length, width, thickness), poisson=0.)
        points = model.points
        model.fixed = np.concatenate((6 * np.flatnonzero(points[:, 0] == 0),
            6 * np.flatnonzero(points[:, 1] == 0) + 1,
            6 * np.flatnonzero((points[:, 0] == 0) & (points[:, 2] == 0)) + 2))
        model.thermal_strain = np.zeros((len(model.elements), 4))
        for index, element in enumerate(model.elements):
            layer = int(points[element.nodes, 2].mean() > thickness / 2)
            element.material = {**element.material, "E": young[layer], "C": isotropic_elasticity(young[layer], 0.)}
            model.thermal_strain[index] = strain[layer]
        result = solve_thermal(model)
        tip = (points[:, 0] == length) & (points[:, 2] == 0)
        actual = result.displacement[tip, 2].mean()
        errors.append(abs(actual / expected - 1))
        assert np.linalg.norm(result.reaction[:, :3].sum(axis=0)) < 1e9 * 4e-4 * width * thickness * 1e-6
    record_property("relative_bending_errors", [float(value) for value in errors])
    assert errors[2] < errors[1] < errors[0]
    assert errors[-1] < .02, errors


@pytest.mark.asyncio
async def test_native_temperature_requires_complete_common_assembly_correspondence():
    whole = await build_volume_subdomain(GeometryService(), layered_scene(), ["base", "metal"], ["base", "metal"], VolumeMeshingProfile(.2, layer_axis=2))
    metal = VolumeSubdomain.create(whole.assembly, whole.field_domain.metadata["assemblyIdentity"], ["metal"])
    temperatures = 300 + whole.field_domain.points @ [1, 2, 3]
    field = FieldValue(whole.field_domain, "node", "thermodynamics.Temperature", "K", temperatures)
    result = transfer_assembly_nodal_field(field, metal.field_domain, quantity_kind=field.quantity_kind, unit="K")
    np.testing.assert_array_equal(result, temperatures[metal.node_ids])
    np.testing.assert_array_equal(field.values, temperatures)
    partial = FieldValue(metal.field_domain, "node", field.quantity_kind, "K", result)
    with pytest.raises(ValueError, match="does not cover"):
        transfer_assembly_nodal_field(partial, whole.field_domain, quantity_kind=field.quantity_kind, unit="K")
    for domain in (
        replace(whole.field_domain, metadata={**whole.field_domain.metadata, "assemblyIdentity": "foreign"}),
        replace(whole.field_domain, points=whole.field_domain.points + .001),
        replace(whole.field_domain, metadata={**whole.field_domain.metadata, "cellRegions": np.zeros(len(whole.cell_ids), dtype=int)}),
    ):
        with pytest.raises(ValueError, match="assembly|correspondence"):
            transfer_assembly_nodal_field(replace(field, domain=domain), whole.field_domain, quantity_kind=field.quantity_kind, unit="K")
