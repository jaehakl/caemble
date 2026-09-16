"""Analytic conservation and canonical thin-layer correspondence."""

import asyncio
from dataclasses import replace

import numpy as np
import pytest

from app.kernel.api import FieldValue
from app.methods.coupling.assembly import transfer_assembly_cell_field
from app.methods.finite_element.scalar import ScalarElements, solve_scalar, surface_integrals
from app.methods.geometry import GeometryService
from app.methods.mesh.models import VolumeMeshingProfile
from app.methods.mesh.subdomain import VolumeSubdomain
from app.methods.mesh.subdomain import build_volume_subdomain
from app.kernel.resources import FileResourceCache
from app.methods.fields.box_grid import BoxGrid
from app.methods.fields.tetrahedral import scalar_box_statistics
from app.solvers.dc_current_density.domain import DcDomain
from app.solvers.dc_current_density.formulation import solve_dc
from app.solvers.heat_transfer.domain import HeatDomain
from app.solvers.heat_transfer.formulation import solve_heat


def layered_scene():
    roots = []
    for name, thickness, height in (("base", .1, 0), ("metal", .001, .0505)):
        roots.append({"id": name, "node": {"kind": "transform", "nodeId": name + "-move",
            "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, height, 0, 0, 0, 1],
            "child": {"kind": "primitive", "nodeId": name + "-box", "primitive": "box", "parameters": {"size": [1, .2, thickness]}}}})
    return {"geometryHash": "scalar-layers", "lengthUnit": "m", "roots": roots, "geometryGroups": [], "surfaceGroups": []}


def test_tet_affine_gradient_and_diffusion_energy():
    points = np.array([[.1, .2, .3], [1.1, .4, .3], [.2, 1.1, .4], [.1, .2, 1.2]])
    e = ScalarElements.prepare(points, [[0, 1, 2, 3]])
    gradient = np.array([2., -3., .5])
    values = points @ gradient + 7
    np.testing.assert_allclose(e.gradient(values), [gradient], atol=1e-14)
    matrix = e.diffusion(np.diag([2., 3., 4.]))
    assert values @ matrix @ values == pytest.approx(e.volumes[0] * (gradient @ np.diag([2., 3., 4.]) @ gradient), rel=1e-12)


def test_layered_mesh_preserves_thickness_regions_and_power():
    service = GeometryService()
    profile = VolumeMeshingProfile(.15, layer_axis=2, layer_subdivisions=(("metal", 3), ("base", 2)))
    mesh = asyncio.run(service.volume_mesh(layered_scene(), ("base", "metal"), "m", profile))
    np.testing.assert_allclose(np.bincount(mesh.cell_region_ids, weights=mesh.quality.cell_volumes), [.02, .0002], rtol=1e-9)
    assert len(np.unique(mesh.points[mesh.cells[mesh.cell_region_ids == 1], 2])) == 4
    electric = VolumeSubdomain.create(mesh, "assembly", ["metal"])
    thermal = VolumeSubdomain.create(mesh, "assembly", ["base", "metal"])
    assert len(electric.node_ids) < len(thermal.node_ids)
    source = FieldValue(electric.field_domain, "cell", "PowerDensity", "W.m-3", np.full(len(electric.cell_ids), 42.))
    imported = transfer_assembly_cell_field(source, thermal.field_domain, quantity_kind="PowerDensity", unit="W.m-3")
    assert imported @ thermal.elements.volumes == pytest.approx(42 * .0002, rel=1e-10)
    assert np.all(imported[mesh.cell_region_ids == 0] == 0)
    wrong = replace(thermal.field_domain, metadata={**thermal.field_domain.metadata, "assemblyIdentity": "other"})
    with pytest.raises(ValueError, match="different assembly"):
        transfer_assembly_cell_field(source, wrong, quantity_kind="PowerDensity", unit="W.m-3")
    for modified in (
        replace(source.domain, points=source.domain.points + [.01, 0, 0]),
        replace(source.domain, metadata={**source.domain.metadata, "cellRegions": np.zeros(len(electric.cell_ids), dtype=int)}),
        replace(source.domain, metadata={**source.domain.metadata, "parentCellIds": source.domain.metadata["parentCellIds"][::-1]}),
    ):
        with pytest.raises(ValueError, match="correspondence"):
            transfer_assembly_cell_field(replace(source, domain=modified), thermal.field_domain, quantity_kind="PowerDensity", unit="W.m-3")
    # A linear potential is exact even with very different layer thicknesses.
    matrix = electric.elements.diffusion(np.eye(3) * 2)
    x = electric.field_domain.points[:, 0]
    fixed = {int(i): float(x[i] + .5) for i in np.flatnonzero(np.isclose(np.abs(x), .5))}
    values, reaction, residual = solve_scalar(matrix, np.zeros(len(x)), fixed, tolerance=1e-8)
    np.testing.assert_allclose(values, x + .5, atol=1e-10)
    assert residual < 1e-8
    assert reaction[x > .49].sum() == pytest.approx(2 * .2 * .001, rel=1e-9)
    assert values @ matrix @ values == pytest.approx(reaction[x > .49].sum(), rel=1e-9)
    with pytest.raises(ValueError, match="connected diffusion"):
        solve_scalar(matrix, np.zeros(len(x)), {}, tolerance=1e-8)


def test_constant_robin_temperature_and_surface_load():
    points = np.array([[0., 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]])
    elements = ScalarElements.prepare(points, [[0, 1, 2, 3]])
    robin, load, areas = surface_integrals(points, [[0, 1, 2]], 5., 5 * 293.15)
    values, reaction, residual = solve_scalar(elements.diffusion(np.eye(3)) + robin, load, {}, tolerance=1e-8, anchored_nodes=[0, 1, 2])
    np.testing.assert_allclose(values, 293.15, atol=1e-10)
    assert load.sum() == pytest.approx(areas.sum() * 5 * 293.15)
    np.testing.assert_allclose(reaction, 0, atol=1e-12)


@pytest.mark.parametrize("arrangement", ["series", "parallel"])
def test_multimaterial_resistance_and_joule_heat_balance(arrangement):
    scene = layered_scene()
    axis = 0 if arrangement == "series" else 1
    for index, root in enumerate(scene["roots"]):
        size = [1., 1., .1]
        size[axis] = .5
        root["node"]["child"]["parameters"]["size"] = size
        root["node"]["matrix"][3] = root["node"]["matrix"][11] = 0
        root["node"]["matrix"][4 * axis + 3] = -.25 + index * .5
    mesh = asyncio.run(GeometryService().volume_mesh(scene, ("base", "metal"), "m", VolumeMeshingProfile(.2, layer_axis=2)))
    domain = VolumeSubdomain.create(mesh, "two-material", ["base", "metal"])
    points = domain.field_domain.points
    left, right = np.flatnonzero(np.isclose(points[:, 0], -.5)), np.flatnonzero(np.isclose(points[:, 0], .5))
    fixed = {int(i): 1. for i in left}
    fixed.update((int(i), 0.) for i in right)
    conductivity = np.array([2., 4.])[mesh.cell_region_ids, None, None] * np.eye(3)
    electric = solve_dc(DcDomain(domain, conductivity, fixed, {"in": {"nodes": left, "voltage": 1.}, "out": {"nodes": right, "voltage": 0.}}), 1e-8)
    expected = .1 / (.5 / 2 + .5 / 4) if arrangement == "series" else .05 * (2 + 4)
    assert electric.input_power == pytest.approx(expected, rel=1e-9)
    assert electric.dissipated_power == pytest.approx(expected, rel=1e-9)
    assert sum(electric.terminal_currents.values()) == pytest.approx(0, abs=1e-10)
    fixed_temperature = {int(i): 293.15 for i in np.r_[left, right]}
    source = FieldValue(domain.field_domain, "cell", "PowerDensity", "W.m-3", electric.joule_heating)
    thermal = solve_heat(HeatDomain(domain, conductivity, fixed_temperature, ()), source, 1e-8)
    assert thermal.source_power == pytest.approx(expected, rel=1e-9)
    assert thermal.outward_power == pytest.approx(expected, rel=1e-8)
    assert np.max(thermal.temperature) > 293.15


def test_layered_heat_resistance_and_flux_robin_signs():
    scene = layered_scene()
    mesh = asyncio.run(GeometryService().volume_mesh(scene, ("base", "metal"), "m", VolumeMeshingProfile(.15, layer_axis=2)))
    domain = VolumeSubdomain.create(mesh, "heat-layers", ["base", "metal"])
    z = domain.field_domain.points[:, 2]
    bottom, top = np.flatnonzero(np.isclose(z, -.05)), np.flatnonzero(np.isclose(z, .051))
    conductivity = np.array([2., 4.])[mesh.cell_region_ids, None, None] * np.eye(3)
    fixed = {int(i): 300. for i in bottom}
    fixed.update((int(i), 310.) for i in top)
    thermal = solve_heat(HeatDomain(domain, conductivity, fixed, ()), None, 1e-8)
    flux = 10 / (.1 / 2 + .001 / 4)
    np.testing.assert_allclose(thermal.heat_flux[:, 2], -flux, rtol=1e-8)
    # Find the outward top surface through canonical provenance, not face order.
    top_faces = domain.node_lookup[mesh.boundary_faces[np.all(np.isclose(mesh.points[mesh.boundary_faces, 2], .051), axis=1)]]
    fixed = {int(i): 300. for i in bottom}
    for boundary in (("heat.flux", top_faces, {"outwardFlux": -100.}),
                     ("heat.convection", top_faces, {"coefficient": 20., "ambientTemperature": 310.})):
        thermal = solve_heat(HeatDomain(domain, conductivity, fixed, (boundary,)), None, 1e-8)
        expected_flux = 100. if boundary[0] == "heat.flux" else 10 / (.1 / 2 + .001 / 4 + 1 / 20)
        np.testing.assert_allclose(thermal.temperature[top], 300 + expected_flux * (.1 / 2 + .001 / 4), rtol=1e-10)
        assert thermal.fixed_outward_power == pytest.approx(.2 * expected_flux, rel=1e-8)
        assert thermal.outward_power == pytest.approx(0., abs=1e-8)


@pytest.mark.asyncio
async def test_layered_cache_and_uncached_assemblies_have_identical_correspondence(tmp_path):
    scene = layered_scene()
    profile = VolumeMeshingProfile(.2, layer_axis=2, layer_subdivisions=(("metal", 2),))
    cache = FileResourceCache(tmp_path)
    first = await build_volume_subdomain(GeometryService(cache=cache), scene, ("base", "metal"), ("metal",), profile)
    cached = await build_volume_subdomain(GeometryService(cache=cache), scene, ("base", "metal"), ("base", "metal"), profile)
    fresh = await build_volume_subdomain(GeometryService(), scene, ("base", "metal"), ("base", "metal"), profile)
    assert first.field_domain.metadata["assemblyIdentity"] == cached.field_domain.metadata["assemblyIdentity"] == fresh.field_domain.metadata["assemblyIdentity"]
    np.testing.assert_array_equal(cached.field_domain.points, fresh.field_domain.points)
    np.testing.assert_array_equal(cached.cell_ids, fresh.cell_ids)
    assert not cached.assembly.points.flags.writeable


@pytest.mark.parametrize("gap", [0.01, 0.1])
def test_separated_thermal_body_is_not_automatically_connected(gap):
    scene = layered_scene()
    scene["roots"][1]["node"]["matrix"][11] += gap
    mesh = asyncio.run(GeometryService().volume_mesh(scene, ("base", "metal"), "m", VolumeMeshingProfile(.2, layer_axis=2)))
    domain = VolumeSubdomain.create(mesh, "separated", ("base", "metal"))
    fixed = {int(node): 293.15 for node in np.unique(domain.elements.cells[mesh.cell_region_ids == 0])}
    tensors = np.broadcast_to(np.eye(3), (len(domain.cell_ids), 3, 3))
    with pytest.raises(ValueError, match="connected diffusion"):
        solve_heat(HeatDomain(domain, tensors, fixed, ()), None, 1e-8)
    with pytest.raises(ValueError, match="connected diffusion"):
        solve_dc(DcDomain(domain, tensors, fixed, {}), 1e-8)


def test_zero_voltage_and_zero_heat_use_absolute_power_tolerance():
    mesh = asyncio.run(GeometryService().volume_mesh(layered_scene(), ("base", "metal"), "m", VolumeMeshingProfile(.2, layer_axis=2)))
    domain = VolumeSubdomain.create(mesh, "zero-power", ("base", "metal"))
    nodes = np.flatnonzero(np.isclose(domain.field_domain.points[:, 0], -.5))
    tensors = np.broadcast_to(np.eye(3), (len(domain.cell_ids), 3, 3))
    electric = solve_dc(DcDomain(domain, tensors, {int(i): 0. for i in nodes}, {"zero": {"nodes": nodes, "voltage": 0.}}), 1e-8)
    assert electric.input_power == electric.dissipated_power == 0
    source = FieldValue(domain.field_domain, "cell", "PowerDensity", "W.m-3", electric.joule_heating)
    thermal = solve_heat(HeatDomain(domain, tensors, {int(i): 293.15 for i in nodes}, ()), source, 1e-8)
    np.testing.assert_allclose(thermal.temperature, 293.15, atol=1e-7, rtol=0)
    # Unit-conductance reference power is 1 W; use its 1e-10 absolute scale.
    assert abs(thermal.outward_power) < 1e-10


@pytest.mark.parametrize("solver", ["dc", "heat"])
@pytest.mark.asyncio
async def test_material_tensor_contract_rejects_anisotropy(solver):
    from tests.test_solver_entries import _dc_invocation, _heat_invocation
    from app.solvers.dc_current_density.domain import build_dc_domain
    from app.solvers.heat_transfer.domain import build_heat_domain
    invocation = _dc_invocation() if solver == "dc" else _heat_invocation()
    key, parameter = ("electrical", "sigma") if solver == "dc" else ("thermal", "k")
    invocation.world["materials"]["experiment"]["test-material"]["models"][key]["parameters"][parameter]["value"] = np.diag([1., 2., 3.]).tolist()
    with pytest.raises(ValueError, match="isotropic"):
        await (build_dc_domain(invocation) if solver == "dc" else build_heat_domain(invocation))


def test_rotated_clipped_box_aggregates_integrate_the_native_linear_field():
    points = np.array([[0., 0, 0], [4, 0, 0], [0, 4, 0], [0, 0, 4]])
    gradient = np.array([2., -3., .5])
    values = points @ gradient + 7
    angle = .4
    rotation = np.array([[np.cos(angle), -np.sin(angle), 0], [np.sin(angle), np.cos(angle), 0], [0, 0, 1]])
    geometry = {"origin": [.8, .8, .2], "size": [.2, .3, .4], "rotation": rotation.tolist(), "lengthUnit": "m", "gridShape": [1, 1, 1], "source": "task", "rootId": "roi"}
    corners = np.array([[i, j, k] for i in (0, .2) for j in (0, .3) for k in (0, .4)]) @ rotation.T + geometry["origin"]
    expected = corners @ gradient + 7
    for shape in ([1, 1, 1], [8, 9, 10]):
        grid = BoxGrid({**geometry, "gridShape": shape})
        actual = scalar_box_statistics(points, [[0, 1, 2, 3]], values, grid)
        np.testing.assert_allclose(actual, [expected.mean(), expected.min(), expected.max()], atol=1e-12)


@pytest.mark.asyncio
async def test_named_terminals_follow_rotated_canonical_surfaces():
    from tests.test_solver_entries import _dc_invocation
    from app.solvers.dc_current_density.domain import build_dc_domain
    invocation = _dc_invocation()
    angle = .61
    scene = invocation.world["experiment"]
    root = scene["roots"][0]
    root["node"] = {"kind": "transform", "nodeId": "rotated-cube", "matrix": [
        np.cos(angle), -np.sin(angle), 0, .3, np.sin(angle), np.cos(angle), 0, -.2,
        0, 0, 1, .1, 0, 0, 0, 1], "child": root["node"]}
    setup = await build_dc_domain(invocation)
    result = solve_dc(setup, 1e-8)
    assert result.terminal_currents["source"] == pytest.approx(1., rel=1e-9)
    assert result.terminal_currents["reference"] == pytest.approx(-1., rel=1e-9)
    np.testing.assert_allclose(result.current_density, np.broadcast_to([np.cos(angle), np.sin(angle), 0], result.current_density.shape), atol=1e-9)


@pytest.mark.parametrize("axis", [0, 1, 2])
def test_layer_direction_preserves_physical_slabs_on_each_axis(axis):
    scene = layered_scene()
    permutation = np.roll(np.arange(3), axis + 1)
    for root in scene["roots"]:
        root["node"]["child"]["parameters"]["size"] = np.array(root["node"]["child"]["parameters"]["size"])[permutation].tolist()
        height = root["node"]["matrix"][11]
        root["node"]["matrix"][11] = 0
        root["node"]["matrix"][4 * axis + 3] = height
    profile = VolumeMeshingProfile(.2, layer_axis=axis, layer_subdivisions=(("metal", 3),))
    mesh = asyncio.run(GeometryService().volume_mesh(scene, ("base", "metal"), "m", profile))
    np.testing.assert_allclose(np.bincount(mesh.cell_region_ids, weights=mesh.quality.cell_volumes), [.02, .0002], rtol=1e-9)
    assert len(np.unique(mesh.points[mesh.cells[mesh.cell_region_ids == 1], axis])) == 4


def test_general_volume_mesher_honors_region_specific_sizes():
    from tests.test_geometry_volume_mesh import _scene, _translated_box
    scene = _scene("regional-volume-sizes", [_translated_box("fine", -.6), _translated_box("coarse", .6)])
    profile = VolumeMeshingProfile(.4, region_max_element_sizes=(("fine", .15),))
    mesh = asyncio.run(GeometryService().volume_mesh(scene, ("fine", "coarse"), "m", profile))
    counts = np.bincount(mesh.cell_region_ids)
    assert counts[0] > counts[1]
    np.testing.assert_allclose(np.bincount(mesh.cell_region_ids, weights=mesh.quality.cell_volumes), [1., 1.], rtol=1e-9)
