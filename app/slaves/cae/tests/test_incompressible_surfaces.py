"""Exact surface clipping, conservative boundary observations and solid loads."""

from types import SimpleNamespace

import numpy as np
import pytest

from app.kernel.api import ContentKey
from app.kernel.coordinator.contracts import validate_artifact_payload
from app.methods.coupling.polygons import intersect_coplanar_triangles, polygon_area_centroid
from app.methods.fields.box_grid import clip_box_polygon
from app.methods.finite_volume.tetrahedral import create_fv_mesh
from app.solvers.incompressible_flow.surface_loads import (
    SurfaceBoxOverlap, SurfaceRecovery, load_settings, select_surfaces, surface_observers,
)
from tests.flow_fixtures import tetrahedral_box
from tests.flow_fixtures import observation


def wall_domain(shape=(3, 3, 3), *, rotation=None, gravity=(0., 0., 0.)):
    mesh = tetrahedral_box(shape, irregular=True)
    rotation = np.eye(3) if rotation is None else np.asarray(rotation)
    if not np.array_equal(rotation, np.eye(3)):
        mesh = create_fv_mesh(mesh.points @ rotation.T, mesh.cells, mesh.faces[mesh.boundary_face_map])
    boundary = mesh.boundary_face_map
    triangles = mesh.faces[boundary]
    center = np.average(mesh.cell_centers, axis=0, weights=mesh.cell_volumes)
    local_centers = mesh.physical_face_centers[boundary] @ rotation
    regions = {"experiment.surface.all": np.arange(len(boundary))}
    for axis, label in enumerate("xyz"):
        for side in (0, 1):
            regions[f"experiment.surface.{label}{side}"] = np.flatnonzero(np.isclose(local_centers[:, axis], side))
    velocity = np.full((mesh.face_count, 3), np.nan)
    velocity[mesh.neighbour < 0] = 0.
    patches = {"interfaceIndices": boundary.copy(), "boundaryIndices": np.arange(len(boundary)),
               "signs": np.ones(len(boundary)), "offsets": np.arange(len(boundary) + 1) * 3,
               "vertices": mesh.points[triangles].reshape(-1, 3)}
    metadata = {"pressureReference": "volume-mean-zero", "pressureReferencePoint": center,
                "hydrostaticGravity": np.asarray(gravity), "drivingAcceleration": np.zeros(3),
                "boundaryFaces": triangles,
                "boundaryProvenance": {"offsets": np.arange(len(boundary) + 1, dtype=np.int32),
                    "sources": np.asarray(["experiment"] * len(boundary)),
                    "rootIds": np.asarray(["fluid"] * len(boundary)),
                    "sourceNodeIds": np.asarray(["box"] * len(boundary)),
                    "surfaceIndices": np.zeros(len(boundary), dtype=np.int32)}}
    return SimpleNamespace(mesh=mesh, density=2., viscosity=.7, gravity=np.asarray(gravity),
        boundary_velocity=velocity, boundary_pressure=np.full(mesh.face_count, np.nan),
        boundary_roles=np.asarray(["wall"] * len(boundary), dtype=object), boundary_patches=patches,
        surface_regions=regions, metadata=metadata, identity="surface-fixture", periodic_topology=None)


@pytest.mark.parametrize("reverse", [False, True])
def test_triangle_intersection_preserves_area_and_first_moment(reverse):
    first = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]])
    second = np.array([[0., 0., 0.], [1., 0., 0.], [1., 1., 0.]])
    overlap = intersect_coplanar_triangles(first, second[::-1] if reverse else second, [0., 0., 1.])
    area, center = polygon_area_centroid(overlap)
    assert area == pytest.approx(.25)
    np.testing.assert_allclose(center, [.5, 1 / 6, 0.], atol=1e-15)
    translated = overlap + [1e7, -2e7, 3e7]
    actual_area, actual_center = polygon_area_centroid(translated)
    assert actual_area == area
    np.testing.assert_allclose(actual_center, center + [1e7, -2e7, 3e7], rtol=0, atol=4e-9)


@pytest.mark.parametrize("unit,scale", [("m", 1.), ("mm", 1000.)])
def test_rotated_triangle_box_partial_intersection_without_centroids(unit, scale):
    angle = .37
    rotation = np.array([[np.cos(angle), -np.sin(angle), 0.], [np.sin(angle), np.cos(angle), 0.], [0., 0., 1.]])
    vertices = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]]) @ rotation.T
    corner = rotation @ np.array([.96, .01, -.02])
    grid = observation((1, 1, 1), corner * scale, np.array([.02, .02, .04]) * scale, rotation, unit)
    assert not grid.contains(vertices.mean(axis=0)) and not grid.contains(vertices).any()
    clipped = clip_box_polygon(vertices, grid)
    area, center = polygon_area_centroid(clipped)
    assert area == pytest.approx(.00035, rel=2e-13)
    assert grid.contains(center)


def test_surface_selection_defaults_duplicates_and_invalid_targets():
    domain = wall_domain()
    x0 = select_surfaces(domain, ["experiment.surface.x0", "experiment.surface.x0"])
    np.testing.assert_array_equal(x0, domain.surface_regions["experiment.surface.x0"])
    with pytest.raises(ValueError, match="no selected fluid boundary"):
        select_surfaces(domain, ["task.surface.x0"])
    domain.surface_regions["experiment.surface.removed"] = np.empty(0, dtype=int)
    with pytest.raises(ValueError, match="no selected fluid boundary"):
        select_surfaces(domain, ["experiment.surface.removed"])
    domain.boundary_roles[x0[0]] = "velocity"
    with pytest.raises(ValueError, match="actual no-slip.*position"):
        select_surfaces(domain, ["experiment.surface.x0"], walls_only=True)
    rule = {"methodId": "flow.observe-surface", "target": ["experiment.surface.x0"], "parameters": {"name": "inlet"}}
    invocation = SimpleNamespace(config={"initializations": [rule, rule]})
    with pytest.raises(ValueError, match="unique nonempty"):
        surface_observers(invocation, domain)
    assert load_settings({}) == (0., "total", None)
    with pytest.raises(ValueError, match="momentOrigin"):
        load_settings({}, moment=True)


def test_flux_observations_use_signed_corrected_flux_and_exact_clipped_area():
    domain = wall_domain()
    grid = observation((1, 1, 1), (-.1, -.1, -.1), (1.2, .6, 1.2))
    flux = 2.7 * domain.mesh.area_vectors[:, 0]
    # Cell velocity is deliberately unrelated: the numerical observable owns phi.
    x0 = SurfaceBoxOverlap.prepare(domain, domain.surface_regions["experiment.surface.x0"], grid)
    x1 = SurfaceBoxOverlap.prepare(domain, domain.surface_regions["experiment.surface.x1"], grid)
    saved = flux[domain.mesh.boundary_interface_indices]
    assert x0.volume_flow(saved, domain.mesh.boundary_interface_indices) == pytest.approx(-1.35, rel=2e-14)
    assert x1.volume_flow(saved, domain.mesh.boundary_interface_indices) == pytest.approx(1.35, rel=2e-14)
    np.testing.assert_allclose(x0.areas.sum(), .5, rtol=2e-14)
    empty = SurfaceBoxOverlap.prepare(domain, np.arange(len(domain.mesh.boundary_face_map)),
                                      observation((1, 1, 1), (4., 4., 4.)))
    assert empty.volume_flow(saved, domain.mesh.boundary_interface_indices) == 0.


def test_pressure_offset_closed_force_and_moment_cancel_but_open_load_changes():
    domain = wall_domain()
    before = ContentKey.from_parts("inputs", domain.mesh.points, domain.boundary_velocity)
    trace = SurfaceRecovery(domain).trace(np.full(len(domain.mesh.cells), -3.), np.zeros((len(domain.mesh.cells), 3)))
    grid = observation((1, 1, 1), (-.1, -.1, -.1), (1.2, 1.2, 1.2))
    closed = SurfaceBoxOverlap.prepare(domain, domain.surface_regions["experiment.surface.all"], grid)
    for offset in (0., 5.):
        np.testing.assert_allclose(closed.force_moment(trace, offset, "total"), 0., atol=1e-14)
        np.testing.assert_allclose(closed.force_moment(trace, offset, "total", np.array([.2, -.3, .4])), 0., atol=1e-14)
    face = SurfaceBoxOverlap.prepare(domain, domain.surface_regions["experiment.surface.x1"], grid)
    force = face.force_moment(trace, 5., "pressure")
    np.testing.assert_allclose(force, [2., 0., 0.], atol=1e-14)
    shift = np.array([.3, -.2, .7])
    zero = face.force_moment(trace, 5., "pressure", np.zeros(3))
    np.testing.assert_allclose(face.force_moment(trace, 5., "pressure", shift), zero - np.cross(shift, force), atol=1e-14)
    assert face.average_pressure(trace) == pytest.approx(-3.)
    assert ContentKey.from_parts("inputs", domain.mesh.points, domain.boundary_velocity) == before


def test_hydrostatic_boundary_force_includes_physical_pressure_and_rotates():
    rotation = np.array([[0., -1., 0.], [1., 0., 0.], [0., 0., 1.]])
    gravity = np.array([.4, -.7, -1.3])
    baseline = None
    for frame in (np.eye(3), rotation):
        domain = wall_domain(rotation=frame, gravity=frame @ gravity)
        pressure = domain.density * ((domain.mesh.cell_centers - domain.metadata["pressureReferencePoint"]) @ domain.gravity)
        trace = SurfaceRecovery(domain).trace(pressure, np.zeros((len(domain.mesh.cells), 3)))
        grid = observation((1, 1, 1), (-2., -2., -2.), (4., 4., 4.))
        whole = SurfaceBoxOverlap.prepare(domain, domain.surface_regions["experiment.surface.all"], grid)
        force = whole.force_moment(trace, 0., "total")
        np.testing.assert_allclose(force, domain.density * domain.gravity * domain.mesh.cell_volumes.sum(), atol=2e-14)
        np.testing.assert_array_equal(trace.viscous_traction, 0.)
        if baseline is not None:
            np.testing.assert_allclose(force, frame @ baseline, atol=2e-14)
        baseline = force


def test_linear_shear_wall_traction_uses_full_newtonian_stress():
    domain = wall_domain()
    mesh = domain.mesh
    physical = mesh.boundary_face_map
    y0 = domain.surface_regions["experiment.surface.y0"]
    domain.boundary_roles[:] = "velocity"
    domain.boundary_roles[y0] = "wall"
    domain.boundary_velocity[mesh.neighbour < 0, 0] = 1.6 * mesh.face_centers[mesh.neighbour < 0, 1]
    velocity = np.zeros((len(mesh.cells), 3))
    velocity[:, 0] = 1.6 * mesh.cell_centers[:, 1]
    trace = SurfaceRecovery(domain).trace(np.full(len(mesh.cells), .2), velocity)
    np.testing.assert_allclose(trace.viscous_traction[y0], np.tile([1.6 * domain.viscosity, 0., 0.], (len(y0), 1)), atol=5e-14)
    np.testing.assert_allclose(trace.pressure_traction[y0], .2 * trace.normals[y0], atol=1e-14)
    np.testing.assert_allclose(trace.traction()[y0], trace.traction(contribution="pressure")[y0] + trace.traction(contribution="viscous")[y0])
    assert np.all(mesh.physical_area_vectors[physical[y0], 1] < 0)


def test_boundary_outputs_history_metadata_and_native_load_share_one_surface_representation():
    from caemble_catalog import open_catalog
    from app.solvers.incompressible_flow.outputs import build_outputs

    with open_catalog() as catalog:
        descriptor = catalog.get_solver_manifest("incompressible-flow", "3.0.0")["descriptor"]
    domain = wall_domain()
    mesh = domain.mesh
    for side, value in ((0, 2.), (1, 1.)):
        ids = domain.surface_regions[f"experiment.surface.x{side}"]
        faces = mesh.boundary_face_map[ids]
        domain.boundary_roles[ids] = "pressure-open"
        domain.boundary_velocity[faces] = np.nan
        domain.boundary_pressure[faces] = value
    domain.metadata["pressureReference"] = "pressure-boundaries"
    pressure, velocity = 2. - mesh.cell_centers[:, 0], np.zeros((len(mesh.cells), 3))
    flux = mesh.area_vectors[:, 0]
    solution = SimpleNamespace(pressure=pressure, velocity=velocity, face_volume_flux=flux)
    grid = observation((1, 1, 1), (-.1, -.1, -.1), (1.2, 1.2, 1.2))
    origin = [.1, .2, .3]
    definitions = {item["methodId"]: item["data"] for item in descriptor["methods"]["outputs"]}
    outputs = [{"key": name, "methodId": f"flow.{method}", "boxGrid": grid.geometry,
                "parameters": {"surface": surface, **settings}} for name, method, surface, settings in (
                    ("inflow", "volume-flow-rate", "inlet", {}),
                    ("outflow", "volume-flow-rate", "outlet", {"scope": "final"}),
                    ("massflow", "mass-flow-rate", "outlet", {}),
                    ("pressure", "surface-pressure", "outlet", {}),
                    ("force", "force", "wall", {"pressureOffset": 2.}),
                    ("moment", "moment", "wall", {"pressureOffset": 2., "momentOrigin": origin}),
                )]
    config = {"parameters": {"analysis": "transient-navier-stokes"}, "outputs": outputs,
        "initializations": [{"methodId": "flow.observe-surface", "target": [f"experiment.surface.{target}"],
            "parameters": {"name": name}} for name, target in (("inlet", "x0"), ("outlet", "x1"), ("wall", "y0"))],
        "exports": [{"key": "traction", "methodId": "flow.traction", "target": ["experiment.surface.y0"],
                     "parameters": {"pressureOffset": 2.}}]}
    invocation = SimpleNamespace(config=config, descriptor=descriptor, cancellation=None)
    times = np.array([0., .2, .35])
    samples = {"times": times, "pressure": np.broadcast_to(pressure, (3, len(pressure))),
               "velocity": np.broadcast_to(velocity, (3, *velocity.shape)),
               "boundaryFlux": np.array([0., .4, 1.])[:, None] * flux[mesh.boundary_interface_indices]}
    artifacts, exports, visuals = build_outputs(invocation, domain, solution, samples=samples, time=.35)
    np.testing.assert_allclose(artifacts["inflow"]["value"].ravel(), [0., -.4, -1.], atol=1e-14)
    np.testing.assert_allclose(artifacts["outflow"]["value"].ravel(), [1.], atol=1e-14)
    np.testing.assert_allclose(artifacts["massflow"]["value"].ravel(), domain.density * np.array([0., .4, 1.]), atol=1e-14)
    np.testing.assert_allclose(artifacts["pressure"]["value"].ravel(), 1., atol=1e-14)
    np.testing.assert_array_equal(artifacts["outflow"]["axes"][3]["ticks"], [.35])
    for output in outputs:
        artifact = artifacts[output["key"]]
        validate_artifact_payload(artifact, definitions[output["methodId"]], output["key"])
        assert artifact["metadata"]["pressureReference"] == "pressure-boundaries"
    assert artifacts["moment"]["metadata"]["momentOrigin"] == origin
    assert artifacts["force"]["metadata"]["pressureOffset"] == 2.
    field = exports["traction"]
    export_data = next(item["data"] for item in descriptor["methods"]["exports"] if item["methodId"] == "flow.traction")
    validate_artifact_payload(field, export_data, "traction", require_spatial_field=True)
    for name, value in visuals.items():
        validate_artifact_payload(value, descriptor["visualizations"][name]["data"], name, require_spatial_field=True)
    triangles = field.domain.points[field.domain.cells["tri3"]]
    areas = np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1) / 2
    forces = areas[:, None] * field.values[:, 0]
    np.testing.assert_allclose(forces.sum(axis=0), artifacts["force"]["value"][0, 0, 0, -1, 0, 0], atol=1e-14)
    np.testing.assert_allclose(np.cross(triangles.mean(axis=1) - origin, forces).sum(axis=0),
                               artifacts["moment"]["value"][0, 0, 0, -1, 0, 0], atol=1e-14)
    assert field.metadata["sampleAxes"][0]["ticks"] == [.35]
    assert visuals["traction"].metadata["pressureOffset"] == 0.
    assert len(visuals["traction"].values) > len(field.values)
