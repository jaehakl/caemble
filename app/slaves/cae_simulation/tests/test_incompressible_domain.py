"""Actual CSG tetrahedra, provenance selection, and physical boundary preparation."""

from tests.flow_fixtures import fluid_invocation

from copy import deepcopy

import numpy as np
import pytest

from app.solvers.incompressible_flow.domain import build_domain, domain_request, prepare_boundaries
from app.solvers.incompressible_flow.state import read_checkpoint, read_settings, save_domain


@pytest.mark.asyncio
async def test_boolean_hole_uses_provenance_and_unassigned_faces_are_walls():
    invocation = fluid_invocation(boolean="hole")
    invocation.world["experiment"]["surfaceGroups"].append({"name": "obstacle", "selectors": [
        {"rootId": "fluid", "sourceNodeId": "hole", "surfaceIndex": side} for side in range(6)]})
    invocation.config["boundaryConditions"] = [
        {"methodId": "flow.pressure-open", "target": ["experiment.surface.ends"], "parameters": {"pressure": -2.}},
        {"methodId": "flow.no-slip", "target": ["experiment.surface.obstacle"], "parameters": {}},
    ]
    before = deepcopy(invocation.world)
    domain = await build_domain(invocation)
    assert invocation.world == before
    np.testing.assert_allclose(domain.mesh.cell_volumes.sum(), .96, rtol=1e-9)
    opening = np.isfinite(domain.boundary_pressure)
    assert np.any(opening) and np.all(domain.boundary_pressure[opening] == -2.)
    assert np.all(np.isnan(domain.boundary_velocity[opening]))
    walls = (domain.mesh.neighbour < 0) & ~opening
    assert np.any(walls) and np.all(domain.boundary_velocity[walls] == 0.)
    provenance = domain.metadata["boundaryProvenance"]
    assert set(provenance["sourceNodeIds"]) == {"outer", "hole"}
    assert domain.metadata["pressureReference"] == "pressure-boundaries"
    assert set(domain.metadata["quality"]) >= {"cellVolumes", "meanRatios"}


@pytest.mark.asyncio
async def test_disconnected_boolean_volume_and_zero_viscosity_are_rejected():
    with pytest.raises(ValueError, match="connect"):
        await build_domain(fluid_invocation(boolean="disconnected"))
    invocation = fluid_invocation()
    invocation.world["materials"]["experiment"]["fluid"]["models"]["newtonian"]["parameters"]["dynamicViscosity"] = 0.
    with pytest.raises(ValueError, match="viscosity.*positive"):
        await build_domain(invocation)


@pytest.mark.asyncio
async def test_mesh_units_and_invalid_boundary_coverage():
    domain = await build_domain(fluid_invocation())
    millimetres = await build_domain(fluid_invocation(length_unit="mm"))
    assert millimetres.mesh.cell_volumes.sum() == pytest.approx(domain.mesh.cell_volumes.sum() * 1e-9)
    assert domain.metadata["pressureReference"] == "volume-mean-zero"
    faces = domain.mesh.boundary_face_map
    mesh = domain.mesh
    regions = {"all": faces, "empty": np.empty(0, dtype=int)}
    pressure = {"methodId": "flow.pressure-open", "target": ["all"], "parameters": {"pressure": 0}}
    with pytest.raises(ValueError, match="undetermined"):
        prepare_boundaries(mesh, regions, [pressure])
    with pytest.raises(ValueError, match="overlap"):
        prepare_boundaries(mesh, regions, [pressure, pressure])
    with pytest.raises(ValueError, match="no fluid boundary"):
        prepare_boundaries(mesh, regions, [{**pressure, "target": ["empty"]}])
    # A single imposed inflow into a closed volume cannot satisfy continuity.
    regions["one"] = faces[:1]
    normal = mesh.area_vectors[faces[0]] / np.linalg.norm(mesh.area_vectors[faces[0]])
    with pytest.raises(ValueError, match="incompatible net"):
        prepare_boundaries(mesh, regions, [{"methodId": "flow.velocity-inlet", "target": ["one"],
                                          "parameters": {"velocity": -normal}}])


@pytest.mark.asyncio
async def test_checkpoint_reuses_physical_mesh_and_ignores_observation_geometry():
    invocation = fluid_invocation()
    controls, _ = read_settings(invocation.config, "steady-stokes")
    request = domain_request(invocation, controls)
    domain = await build_domain(invocation, request)
    clock = {"dt": .1, "duration": 1., "windowSize": .5, "outputInterval": .2}
    saved = {"model": save_domain(domain), "clock": clock}
    assert saved["model"]["requestIdentity"] == request["identity"]
    altered_mesh = deepcopy(domain)
    altered_mesh.mesh.points[0, 0] += .001
    assert save_domain(altered_mesh)["identity"] != saved["model"]["identity"]
    changed = deepcopy(invocation.world)
    changed["experiment"]["geometryHash"] = "observation-box-changed"
    changed["experiment"]["roots"].append({"id": "observer", "node": {
        "kind": "primitive", "nodeId": "observer", "primitive": "box", "parameters": {"size": [3., 2., 1.]}}})
    invocation.world = changed
    invocation.config["outputs"] = [{"key": "pressure", "boxGrid": {"gridShape": [9, 7, 4]}}]
    observed_request = domain_request(invocation, controls)
    assert observed_request["identity"] == request["identity"]
    restored = read_checkpoint(saved, observed_request, {**clock, "outputInterval": .13})
    assert save_domain(restored)["identity"] == saved["model"]["identity"]
    assert restored.mesh.points is domain.mesh.points
    np.testing.assert_array_equal(restored.mesh.faces, domain.mesh.faces)
    np.testing.assert_array_equal(restored.mesh.owner, domain.mesh.owner)
    np.testing.assert_array_equal(restored.mesh.neighbour, domain.mesh.neighbour)
    for name in ("dt", "duration", "windowSize"):
        with pytest.raises(ValueError, match="physical time settings"):
            read_checkpoint(saved, observed_request, {**clock, name: clock[name] * 2})
    changed["materials"]["experiment"]["fluid"]["models"]["newtonian"]["parameters"]["density"] = 1200.
    with pytest.raises(ValueError, match="different geometry, material"):
        read_checkpoint(saved, domain_request(invocation, controls), clock)


def test_analysis_and_time_initialization_are_explicit():
    config = fluid_invocation().config
    controls, clock = read_settings(config, "steady-stokes")
    assert clock is None and controls["maxCourant"] == .5
    with pytest.raises(ValueError, match="exactly one"):
        read_settings(config, "transient-navier-stokes")
    config["initializations"].append({"methodId": "flow.time", "target": [], "parameters": {
        "dt": .1, "duration": 1., "windowSize": .4, "outputInterval": .3}})
    _, clock = read_settings(config, "transient-navier-stokes")
    assert clock["windowSize"] == .4
    with pytest.raises(ValueError, match="does not accept"):
        read_settings(config, "steady-stokes")
    config["initializations"][-1]["target"] = ["experiment.geometry.fluid"]
    with pytest.raises(ValueError, match="target-free"):
        read_settings(config, "transient-navier-stokes")
    config["initializations"][-1]["target"] = []
    config["initializations"].append(deepcopy(config["initializations"][-1]))
    with pytest.raises(ValueError, match="exactly one"):
        read_settings(config, "transient-navier-stokes")
    config["initializations"].pop()
    for name in ("dt", "duration", "windowSize", "outputInterval"):
        for invalid in (0., -1., float("inf"), float("nan")):
            altered = deepcopy(config)
            altered["initializations"][-1]["parameters"][name] = invalid
            with pytest.raises(ValueError, match="finite and positive"):
                read_settings(altered, "transient-navier-stokes")
    config["parameters"]["maxNonlinearIterations"] = 30.
    controls, _ = read_settings(config, "transient-navier-stokes")
    assert isinstance(controls["maxNonlinearIterations"], int)


def test_foreign_explicit_surface_cannot_hide_inside_a_matching_checkpoint_request():
    invocation = fluid_invocation()
    invocation.config["boundaryConditions"] = [{"methodId": "flow.pressure-open",
        "target": ["experiment.surface.ends"], "parameters": {"pressure": 0.}}]
    original = domain_request(invocation)
    invocation.world["experiment"]["surfaceGroups"].append({"name": "foreign", "selectors": [
        {"rootId": "observer", "sourceNodeId": "observer", "surfaceIndex": 0}]})
    assert domain_request(invocation)["identity"] == original["identity"]
    invocation.config["boundaryConditions"][0]["target"].append("experiment.surface.foreign")
    with pytest.raises(ValueError, match="foreign.*has no fluid boundary"):
        domain_request(invocation)
