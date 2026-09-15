"""Independent reproductions from the final particle-physics review."""

import manifold3d
import numpy as np
import pytest

from app.methods.geometry import GeometryService, TriangularMesh
from app.methods.particles.sampling import SurfaceQuery
from app.solvers.dem.formulation import DemStepper
from tests.test_dem_particles import setup_particles
from tests.test_geometry_solids import boolean, box, scene, transformed


def test_dem_outside_convex_edge_is_not_misclassified_as_inside_wall():
    raw = manifold3d.Manifold.cube((1, 1, 1)).to_mesh64()
    mesh = TriangularMesh(np.asarray(raw.vert_properties)[:, :3], np.asarray(raw.tri_verts), ())
    wall = {"id": "box", "materialIndex": 0, "query": SurfaceQuery(mesh)}
    # The center is outside x=1, 1 mm into the sphere contact layer. It is
    # below z=1, so that adjacent face's edge is not another exposed contact.
    model, state = setup_particles([[1.099, .5, .995]], [[0, 0, 0]], radius=[.1])
    following, _ = DemStepper(model, [wall])(state, 1e-5)
    assert following["velocity"][0, 0] > 0
    np.testing.assert_allclose(following["velocity"][0, 1:], 0, atol=1e-14)


@pytest.mark.asyncio
async def test_dem_canonical_boolean_coplanar_seam_has_one_normal_contact():
    left = transformed(box("left", [1, 2, 1]), [-.5, 0, -.5])
    right = transformed(box("right", [1, 2, 1]), [.5, 0, -.5])
    mesh = await GeometryService().triangular_mesh(scene(boolean("floor", "union", left, right)), "body", "m")
    wall = {"id": "floor", "materialIndex": 0, "query": SurfaceQuery(mesh)}
    model, state = setup_particles([[.005, 0, .09]], [[0, 0, 0]], radius=[.1])
    following, dt = DemStepper(model, [wall])(state, 1e-5)
    # Geometry-source seams in a flat floor cannot create a lateral force or
    # count the same penetration twice.
    np.testing.assert_allclose(following["velocity"][0], [0, 0, dt * 1e4 * .01], atol=1e-14)
    assert len(following["contactHistory"]) == 1


def test_dem_tangential_history_survives_continuous_convex_edge_contact():
    raw = manifold3d.Manifold.cube((1, 1, 1)).to_mesh64()
    mesh = TriangularMesh(np.asarray(raw.vert_properties)[:, :3], np.asarray(raw.tri_verts), ())
    wall = {"id": "box", "materialIndex": 0, "query": SurfaceQuery(mesh)}
    model, state = setup_particles([[1.099, .5, .99999]], [[0, 0, 2]], radius=[.1], friction=(1, 1))
    feature = wall["query"].contacts(state["positions"][0], .1)[0][-1]
    # An existing sticking spring points along the edge. Traveling 20 um
    # across that edge keeps contact and cannot unload this orthogonal spring.
    state["contactHistory"][f"w:0:box:{feature}"] = {
        "normal": np.array([1., 0, 0]), "displacement": np.array([0., 1e-4, 0])}
    stepper = DemStepper(model, [wall])
    crossed, _ = stepper(state, 1e-5)
    following, _ = stepper(crossed, 1e-5)
    assert len(crossed["contactHistory"]) == len(following["contactHistory"]) == 1
    memory = next(iter(following["contactHistory"].values()))
    assert memory["displacement"][1] == pytest.approx(1e-4, rel=1e-5)


@pytest.mark.asyncio
async def test_dem_concave_contacts_keep_independent_history_as_one_point_moves():
    angle = np.deg2rad(5)
    rotation = np.array([[np.cos(angle), 0, np.sin(angle)], [0, 1, 0],
                         [-np.sin(angle), 0, np.cos(angle)]])
    left = transformed(box("left", [1, 2, 1]), rotation @ [-.5, 0, -.5], rotation)
    right = transformed(box("right", [1, 2, 1]), rotation.T @ [.5, 0, -.5], rotation.T)
    mesh = await GeometryService().triangular_mesh(scene(boolean("corner", "union", left, right)), "body", "m")
    wall = {"id": "corner", "materialIndex": 0, "query": SurfaceQuery(mesh)}
    contacts = sorted(wall["query"].contacts(np.array([0., 0, .09]), .1), key=lambda contact: contact[0][0])
    assert len(contacts) == 2
    # This shallow concave corner puts both contacts within the history
    # matcher's distance and normal bounds, so proximity cannot identify them.
    assert np.linalg.norm(contacts[0][0] - contacts[1][0]) < .025
    assert np.dot(contacts[0][2], contacts[1][2]) > .5
    model, state = setup_particles([[0, 0, .09]], [.2 * contacts[0][2]], radius=[.1], friction=(1, 1))
    expected = {}
    for contact, spring in zip(contacts, (1e-4, -2e-4), strict=True):
        point, _, normal, feature = contact
        key = f"w:0:corner:{feature}"
        expected[key] = spring
        state["contactHistory"][key] = {"normal": normal, "point": point,
                                        "displacement": np.array([0., spring, 0])}
    stepper = DemStepper(model, [wall])
    moved, _ = stepper(state, 1e-5)
    following, _ = stepper(moved, 1e-5)
    assert following["contactHistory"].keys() == expected.keys()
    for key, spring in expected.items():
        assert following["contactHistory"][key]["displacement"][1] == pytest.approx(spring, rel=1e-5)
    travel = [np.linalg.norm(following["contactHistory"][key]["point"] - state["contactHistory"][key]["point"])
              for key in expected]
    assert travel[0] < 1e-8
    assert travel[1] > 1e-7
