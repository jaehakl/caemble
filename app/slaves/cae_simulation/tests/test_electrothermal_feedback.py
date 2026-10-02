"""Independent two-sided conduction, constitutive quadrature and transient balances."""

import asyncio
from dataclasses import replace
from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.api import BundleValue, FieldValue, UnstructuredMeshValue
from app.methods.coupling.assembly import transfer_assembly_element_nodal_field
from app.methods.finite_element.scalar import ScalarElements, TET4_QUADRATURE
from app.methods.geometry import GeometryService
from app.methods.mesh.interfaces import split_interface_nodes
from app.methods.mesh.models import VolumeMeshingProfile
from app.methods.mesh.subdomain import VolumeSubdomain
from app.solvers.dc_current_density.materials import evaluate_conductivity
from app.solvers.dc_current_density.domain import DcDomain
from app.solvers.dc_current_density.formulation import solve_dc
from app.solvers.dc_current_density.time import pulse_voltage
from app.solvers.heat_transfer.domain import HeatDomain
from app.solvers.heat_transfer.formulation import solve_heat
from app.solvers.heat_transfer.evolution import evaluate_heat_invocation
from tests.scalar_fixtures import layered_scene


def interface_domain():
    scene = layered_scene()
    for index, root in enumerate(scene["roots"]):
        root["node"]["child"]["parameters"]["size"] = [1., 1., .5]
        root["node"]["matrix"][11] = -.25 + .5 * index
    mesh = asyncio.run(GeometryService().volume_mesh(scene, ("base", "metal"), "m", VolumeMeshingProfile(.3, layer_axis=2)))
    subset = VolumeSubdomain.create(mesh, "two-layer", ["base", "metal"])
    faces = mesh.boundary_faces[np.all(np.abs(mesh.points[mesh.boundary_faces, 2]) < 1e-12, axis=1)]
    domain, traces = split_interface_nodes(subset.field_domain, faces)
    first, second = [], []
    for face in faces:
        pair = dict(traces[tuple(sorted(face))])
        first.append(pair[0]); second.append(pair[1])
    return subset, replace(subset, field_domain=domain, elements=ScalarElements.prepare(domain.points, domain.cells["tet4"])), (np.asarray(first), np.asarray(second), 5.)


def test_interface_temperature_jump_flux_and_native_side_transfer():
    original, mesh, interface = interface_domain()
    z = mesh.field_domain.points[:, 2]
    fixed = {int(node): 300. if z[node] < 0 else 310. for node in np.flatnonzero(np.isclose(abs(z), .5))}
    regions = mesh.field_domain.metadata["cellRegions"]
    conductivity = np.where(np.asarray(regions) == 0, 2., 4.)[:, None, None] * np.eye(3)
    setup = HeatDomain(mesh, conductivity, fixed, (), (interface,))
    result = solve_heat(setup, None, 1e-8)
    power = 10 / (.5 / 2 + 1 / 5 + .5 / 4)
    first, second, coefficient = interface
    np.testing.assert_allclose(result.temperature[second] - result.temperature[first], power / coefficient, atol=1e-10)
    temperatures = transfer_assembly_element_nodal_field(
        FieldValue(mesh.field_domain, "node", "thermodynamics.Temperature", "K", result.temperature),
        original.field_domain, quantity_kind="thermodynamics.Temperature", unit="K")
    assert np.ptp(temperatures[:, 0]) > 0
    np.testing.assert_allclose(temperatures, result.temperature[mesh.elements.cells], atol=0)
    np.testing.assert_allclose(result.heat_flux[:, 2], -power, rtol=1e-9)
    assert abs(result.outward_power) < power * 1e-10


def test_insulated_transient_capacity_heating_and_zero_source_restart():
    original, _, _ = interface_domain()
    setup = HeatDomain(original, np.broadcast_to(np.eye(3), (len(original.cell_ids), 3, 3)), {}, (),
                       volumetric_capacity=np.full(len(original.cell_ids), 1200.))
    source = FieldValue(original.field_domain, "cell", "PowerDensity", "W.m-3", np.full(len(original.cell_ids), 600.))
    previous = np.full(len(original.node_ids), 300.)
    result = solve_heat(setup, source, 1e-8, previous=previous, time_step=.2, reference_temperature=300.)
    np.testing.assert_allclose(result.temperature, 300.1, atol=1e-11)
    assert result.stored_energy == pytest.approx(120., rel=1e-9)
    assert result.storage_power == pytest.approx(result.source_power, rel=1e-9)
    cooled = solve_heat(setup, None, 1e-8, previous=result.temperature, time_step=.2, reference_temperature=300.)
    np.testing.assert_allclose(cooled.temperature, result.temperature, atol=1e-11)
    np.testing.assert_array_equal(previous, np.full(len(previous), 300.))
    with pytest.raises(ValueError, match="constraint"):
        solve_heat(setup, None, 1e-8)


def test_resistivity_uses_p1_quadrature_and_rejects_invalid_temperature():
    mesh, _, _ = interface_domain()
    temperatures = 300 + 20 * (mesh.field_domain.points[:, 2] + .5)
    field = FieldValue(mesh.field_domain, "node", "thermodynamics.Temperature", "K", temperatures)
    law = {"model": "electrical.linear-resistivity@1", "parameters": {
        "rhoRef": {"value": np.eye(3) * 2.}, "alphaR": .01, "referenceTemperature": 300.,
        "minimumTemperature": 290., "maximumTemperature": 330.}}
    actual = evaluate_conductivity(mesh, dict.fromkeys(("base", "metal"), law), field)
    expected = np.mean(1 / (2 * (1 + .01 * (temperatures[mesh.elements.cells] @ TET4_QUADRATURE.T - 300))), axis=1)
    np.testing.assert_allclose(actual[:, 0, 0], expected, rtol=1e-14)
    np.testing.assert_array_equal(field.values, temperatures)
    with pytest.raises(ValueError, match="valid temperature range"):
        evaluate_conductivity(mesh, dict.fromkeys(("base", "metal"), law), replace(field, values=temperatures + 100))


def test_coupling_trials_use_one_accepted_base_and_verify_without_relaxation():
    mesh, _, _ = interface_domain()
    setup = HeatDomain(mesh, np.broadcast_to(np.eye(3), (len(mesh.cell_ids), 3, 3)), {}, (),
                       volumetric_capacity=np.full(len(mesh.cell_ids), 1200.))
    config = {"parameters": {"analysis": "transient", "relativeTolerance": 1e-8}, "initializations": [
        {"methodId": "heat.time-grid", "parameters": {"times": [0., .2, .4], "initialTemperature": 300.}},
        {"methodId": "heat.coupling", "parameters": {"initialTemperature": 300., "relaxation": .5,
            "relativeTolerance": 1e-8, "absoluteTolerance": 1e-8, "maxIterations": 100}}]}
    invocation = SimpleNamespace(config=config, state={}, inputs={}, task_name="heat", cancellation=None)
    _, initial, _, control, state, _, accepted, status = evaluate_heat_invocation(invocation, setup)
    assert accepted and status["initialized"] and state["time"] == 0
    source = FieldValue(mesh.field_domain, "cell", "PowerDensity", "W.m-3", np.full(len(mesh.cell_ids), 600.))
    base = {"heat_transfer": {"heat": state}}
    estimate = initial
    for iteration in range(100):
        invocation.state = base
        invocation.inputs = {"heatSource": SimpleNamespace(value=source), "temperatureEstimate": SimpleNamespace(value=estimate),
                             "stepControl": SimpleNamespace(value=control)}
        result, native, estimate, next_control, candidate, _, accepted, status = evaluate_heat_invocation(invocation, setup)
        assert estimate.metadata["accepted"] is False
        np.testing.assert_allclose(result.temperature, 300.1, atol=1e-11)
        np.testing.assert_array_equal(base["heat_transfer"]["heat"]["temperature"], initial.values)
        assert candidate["time"] == .2
        if status["couplingConverged"]:
            break
        assert not accepted
    assert iteration > 10 and status["couplingConverged"] and accepted
    assert next_control.members["startTime"] == .2
    # Feeding the same interval an advanced state cannot advance physical time twice.
    invocation.state = {"heat_transfer": {"heat": candidate}}
    with pytest.raises(ValueError, match="accepted Heat state"):
        evaluate_heat_invocation(invocation, setup)
    invocation.inputs = {}
    with pytest.raises(ValueError, match="step-control"):
        evaluate_heat_invocation(invocation, setup)


def test_temperature_side_transfer_rejects_missing_or_mismatched_provenance():
    original, mesh, _ = interface_domain()
    field = FieldValue(mesh.field_domain, "node", "thermodynamics.Temperature", "K", np.full(len(mesh.field_domain.points), 300.))
    for modified in (
        replace(field.domain, metadata={**field.domain.metadata, "assemblyIdentity": "different"}),
        replace(field.domain, points=field.domain.points + [.001, 0, 0]),
        replace(field.domain, metadata={**field.domain.metadata, "cellRegions": 1 - field.domain.metadata["cellRegions"]}),
        replace(field.domain, metadata={**field.domain.metadata, "parentCellIds": field.domain.metadata["parentCellIds"] + 1}),
    ):
        with pytest.raises(ValueError, match="assembly|correspondence"):
            transfer_assembly_element_nodal_field(replace(field, domain=modified), original.field_domain,
                                                  quantity_kind="thermodynamics.Temperature", unit="K")
    with pytest.raises(ValueError, match="finite value"):
        transfer_assembly_element_nodal_field(replace(field, values=field.values[:-1]), original.field_domain,
                                              quantity_kind="thermodynamics.Temperature", unit="K")


@pytest.mark.parametrize("quantity_kind,source_unit,target_unit,sides,expected", [
    ("thermodynamics.Temperature", "Cel", "K", (20., 40.), (293.15, 313.15)),
    ("mechanics.Pressure", "kPa", "Pa", (2., 7.), (2000., 7000.)),
])
def test_element_nodal_transfer_preserves_scalar_interface_sides_and_units(
        quantity_kind, source_unit, target_unit, sides, expected):
    original, mesh, _ = interface_domain()
    regions = np.asarray(mesh.field_domain.metadata["cellRegions"])
    values = np.empty(len(mesh.field_domain.points))
    for region, value in enumerate(sides):
        values[mesh.elements.cells[regions == region]] = value
    values.setflags(write=False)
    field = FieldValue(mesh.field_domain, "node", quantity_kind, source_unit, values)
    result = transfer_assembly_element_nodal_field(
        field, original.field_domain, quantity_kind=quantity_kind, unit=target_unit)
    np.testing.assert_allclose(result, np.broadcast_to(np.asarray(expected)[regions, None], result.shape),
                               rtol=0, atol=1e-12)
    for region, value in enumerate(sides):
        np.testing.assert_array_equal(values[mesh.elements.cells[regions == region]], value)
    with pytest.raises(ValueError, match="quantity does not match"):
        transfer_assembly_element_nodal_field(field, original.field_domain,
                                              quantity_kind="different.quantity", unit=target_unit)


def test_pulse_clock_hits_switches_and_rejects_crossing_or_foreign_intervals():
    domain = regular_tetrahedron().mesh.field_domain
    parameters = {"onTime": .005, "offTime": .005, "voltage": .08}
    for index, (start, end, expected) in enumerate(((0., .005, .08), (.005, .01, 0.), (.01, .015, .08)), 1):
        control = BundleValue("caemble.heat/step-control@1", {"startTime": start, "endTime": end,
            "index": np.array(index, dtype=np.int32), "complete": False},
            {"assemblyIdentity": "regular-tet", "clockIdentity": "clock"})
        assert pulse_voltage(SimpleNamespace(value=control), domain, parameters) == expected
    with pytest.raises(ValueError, match="crosses a pulse transition"):
        pulse_voltage(SimpleNamespace(value=replace(control, members={**control.members, "startTime": .004, "endTime": .006})), domain, parameters)
    with pytest.raises(ValueError, match="different assembly"):
        pulse_voltage(SimpleNamespace(value=replace(control, metadata={**control.metadata, "assemblyIdentity": "other"})), domain, parameters)
    with pytest.raises(ValueError, match="positive finite time"):
        pulse_voltage(SimpleNamespace(value=replace(control, members={**control.members, "complete": True})), domain, parameters)


def test_cg_amg_scalar_diffusion_matches_direct():
    mesh, _, _ = interface_domain()
    z = mesh.field_domain.points[:, 2]
    setup = HeatDomain(mesh, np.broadcast_to(np.eye(3), (len(mesh.cell_ids), 3, 3)),
        {int(i): 300 + 10 * z[i] for i in np.flatnonzero(np.isclose(abs(z), .5))}, ())
    direct = solve_heat(setup, None, 1e-8)
    iterative = solve_heat(setup, None, 1e-8, backend="cg-amg")
    np.testing.assert_allclose(iterative.temperature, direct.temperature, rtol=1e-9, atol=1e-8)
    assert iterative.relative_residual < 1e-8


def regular_tetrahedron():
    # All four boundary faces have equal area. The constant nodal vector is
    # an exact generalized capacity/Robin eigenvector, so the RC reduction
    # below is independent of conductivity and involves no lumped mass.
    points = np.array([[0., 0, 0], [1., 0, 0], [.5, np.sqrt(3) / 2, 0],
                       [.5, np.sqrt(3) / 6, np.sqrt(2 / 3)]])
    cells = np.array([[0, 1, 2, 3]])
    domain = UnstructuredMeshValue(points, {"tet4": cells}, "m", "regular-tet", {
        "assemblyIdentity": "regular-tet", "parentNodeIds": np.arange(4), "parentCellIds": np.array([0]),
        "cellRegions": np.array([0]), "regionIds": ("solid",)})
    mesh = SimpleNamespace(field_domain=domain, elements=ScalarElements.prepare(points, cells),
        node_ids=np.arange(4), cell_ids=np.array([0]), assembly=SimpleNamespace(region_ids=("solid",)))
    faces = np.array([[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]])
    return HeatDomain(mesh, np.eye(3)[None], {}, (("heat.convection", faces,
        {"coefficient": 20., "ambientTemperature": 300.}),), volumetric_capacity=np.array([1200.]))


@pytest.mark.validation
def test_consistent_capacity_robin_rc_heating_cooling_and_first_order_time_convergence():
    setup = regular_tetrahedron()
    volume = setup.mesh.elements.volumes.sum()
    conductance = 20 * np.sqrt(3)
    tau = 1200 * volume / conductance
    source = FieldValue(setup.mesh.field_domain, "cell", "PowerDensity", "W.m-3", np.array([600.]))
    rise = 600 * volume / conductance
    errors = []
    for count in (10, 20, 40):
        dt = tau / count
        temperature = np.full(4, 300.)
        energy = 0.
        for index in range(2 * count):
            result = solve_heat(setup, source if index < count else None, 1e-8,
                previous=temperature, time_step=dt, reference_temperature=300.)
            np.testing.assert_allclose(result.temperature, result.temperature.mean(), atol=1e-11)
            assert result.source_power * dt == pytest.approx(
                result.stored_energy - energy + result.outward_power * dt, abs=600 * volume * dt * 1e-9)
            temperature, energy = result.temperature, result.stored_energy
            if index == count - 1:
                discrete = rise * (1 - (1 + dt / tau) ** -count)
                assert temperature.mean() - 300 == pytest.approx(discrete, rel=1e-10)
                errors.append(abs(discrete - rise * (1 - np.exp(-1))))
        assert temperature.mean() - 300 == pytest.approx(discrete * (1 + dt / tau) ** -count, rel=1e-10)
    assert .45 < errors[1] / errors[0] < .55
    assert .45 < errors[2] / errors[1] < .55


@pytest.mark.parametrize("alpha", [0., .01])
def test_feedback_matches_independent_resistor_thermal_resistance_solution(alpha):
    setup = regular_tetrahedron()
    mesh = setup.mesh
    coordinates = mesh.field_domain.points
    # Prescribed affine voltage: P0 = sigma * |grad V|^2 * volume.
    fixed = dict(enumerate(coordinates[:, 0] * 10))
    terminals = {str(i): {"nodes": np.array([i]), "voltage": v} for i, v in fixed.items()}
    model = {"model": "electrical.linear-resistivity@1", "parameters": {
        "rhoRef": {"value": np.eye(3) * 2}, "alphaR": alpha, "referenceTemperature": 300.,
        "minimumTemperature": 290., "maximumTemperature": 400.}}
    invocation = SimpleNamespace(config={"parameters": {"relativeTolerance": 1e-8}, "initializations": [
        {"methodId": "heat.coupling", "parameters": {"initialTemperature": 300., "relaxation": .5,
            "relativeTolerance": 1e-10, "absoluteTolerance": 1e-10, "maxIterations": 100}}]},
        inputs={}, state={}, task_name="heat", cancellation=None)
    _, estimate, _, _, _, _, _, _ = evaluate_heat_invocation(invocation, setup)
    for _ in range(100):
        conductivity = evaluate_conductivity(mesh, {"solid": model}, estimate)
        electric = solve_dc(DcDomain(mesh, conductivity, fixed, terminals), 1e-8)
        source = FieldValue(mesh.field_domain, "cell", "PowerDensity", "W.m-3", electric.joule_heating)
        invocation.inputs = {"heatSource": SimpleNamespace(value=source), "temperatureEstimate": SimpleNamespace(value=estimate)}
        result, _, estimate, _, _, _, accepted, status = evaluate_heat_invocation(invocation, setup)
        if accepted:
            break
    assert accepted and status["couplingConverged"]
    constant_rise = 50 * mesh.elements.volumes.sum() / (20 * np.sqrt(3))
    expected_rise = constant_rise if alpha == 0 else 2 * constant_rise / (1 + np.sqrt(1 + 4 * alpha * constant_rise))
    np.testing.assert_allclose(result.temperature - 300, expected_rise, rtol=1e-8)
    np.testing.assert_allclose([electric.input_power, electric.dissipated_power, result.source_power], result.outward_power, rtol=1e-8)
    invocation.config["initializations"][0]["parameters"]["maxIterations"] = 2
    invocation.inputs["temperatureEstimate"] = SimpleNamespace(value=replace(estimate, values=np.full(4, 350.),
        metadata={"couplingIteration": 1}))
    with pytest.raises(ValueError, match="did not converge"):
        evaluate_heat_invocation(invocation, setup)
