"""Conservative observations, canonical Boolean sampling and passive time samples."""

import manifold3d
import numpy as np
import pytest

from app.methods.fields.box_grid import BoxGrid
from app.methods.geometry import TriangularMesh
from app.methods.particles.outputs import sample_cells
from app.methods.particles.sampling import sample_mesh_lattice, SurfaceQuery
from app.methods.particles.time import initial_window, advance_window, history_values


@pytest.mark.asyncio
async def test_lattice_preserves_boolean_hole_and_reproducibility():
    solid = manifold3d.Manifold.cube((.04, .04, .04), True) - manifold3d.Manifold.cube((.02, .02, .02), True)
    raw = solid.to_mesh64()
    mesh = TriangularMesh(np.asarray(raw.vert_properties)[:, :3], np.asarray(raw.tri_verts), ())
    first = await sample_mesh_lattice(mesh, .01)
    second = await sample_mesh_lattice(mesh, .01)
    assert len(first) == 56
    np.testing.assert_array_equal(first, second)
    assert np.all(np.any(np.abs(first) > .01, axis=1))
    _, distances, _, _ = SurfaceQuery(mesh).closest(first)
    assert np.all(distances >= .005 - 1e-12)


def test_convex_wall_edge_is_one_contact_and_concave_faces_stay_distinct():
    raw = manifold3d.Manifold.cube((1, 1, 1)).to_mesh64()
    mesh = TriangularMesh(np.asarray(raw.vert_properties)[:, :3], np.asarray(raw.tri_verts), ())
    contacts = SurfaceQuery(mesh).contacts(np.array([1.05, .5, 1.05]), .1)
    assert len(contacts) == 1
    np.testing.assert_allclose(contacts[0][0], [1, .5, 1], atol=1e-12)
    cavity = manifold3d.Manifold.cube((3, 3, 3), True) - manifold3d.Manifold.cube((2, 2, 2), True)
    raw = cavity.to_mesh64()
    mesh = TriangularMesh(np.asarray(raw.vert_properties)[:, :3], np.asarray(raw.tri_verts), ())
    contacts = SurfaceQuery(mesh).contacts(np.array([.95, 0, .95]), .1)
    assert len(contacts) == 2


def test_rotated_box_observation_preserves_mass_and_momentum_with_empty_cells():
    rotation = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]])
    grid = BoxGrid({"origin": [1, 2, 3], "size": [2, 2, 2], "rotation": rotation,
                    "gridShape": [2, 2, 2], "lengthUnit": "m", "source": "experiment", "rootId": "probe"})
    positions = np.array([1, 2, 3]) + np.array([[.1, .1, .1], [.2, .2, .2], [1.5, 1.5, 1.5]]) @ rotation.T
    velocity = np.array([[1, 0, 0], [-1, 2, 0], [0, 0, 3]])
    mass = np.array([2, 1, 4])
    values = sample_cells(positions, velocity, mass, grid)
    assert values["mass-density"].sum() == 7
    np.testing.assert_allclose(values["momentum-density"].sum(axis=(0, 1, 2)), (mass[:, None] * velocity).sum(axis=0))
    np.testing.assert_allclose(values["velocity"][0, 0, 0], [1 / 3, 2 / 3, 0])
    assert np.count_nonzero(values["mass-density"]) == 2
    assert np.all(np.isfinite(values["velocity"]))


@pytest.mark.asyncio
async def test_observation_interval_does_not_change_physical_steps_and_final_is_endpoint():
    def observe(state):
        return {"positions": state["positions"], "velocity": state["velocity"]}

    def step(state, dt):
        velocity = state["velocity"] + dt
        return {"velocity": velocity, "positions": state["positions"] + dt * velocity}, dt

    initial = {"positions": np.zeros((1, 3)), "velocity": np.ones((1, 3))}
    settings = {"dt": .01, "duration": .09, "windowSize": .03, "outputInterval": .007}
    first = await advance_window(initial_window(initial, observe), settings, step, observe)
    changed = await advance_window(initial_window(initial, observe), {**settings, "outputInterval": .023}, step, observe)
    np.testing.assert_array_equal(first["state"]["positions"], changed["state"]["positions"])
    assert first["steps"] == changed["steps"]
    np.testing.assert_array_equal(history_values(first, "final")["positions"][0], first["state"]["positions"])
    continued = await advance_window(first, settings, step, observe)
    whole = await advance_window(initial_window(initial, observe), {**settings, "windowSize": .06}, step, observe)
    np.testing.assert_array_equal(continued["state"]["positions"], whole["state"]["positions"])


@pytest.mark.asyncio
async def test_decimal_window_boundary_keeps_every_output_tick():
    def observe(state):
        return {"positions": state}

    def step(state, dt):
        return state + dt, dt

    initial = np.zeros((1, 3))
    settings = {"dt": .0001, "duration": .35, "windowSize": .175, "outputInterval": .005}
    first = await advance_window(initial_window(initial, observe), settings, step, observe)
    final = await advance_window(first, settings, step, observe)
    whole = await advance_window(initial_window(initial, observe), {**settings, "windowSize": .35}, step, observe)
    sampled = history_values(final)
    assert len(sampled["times"]) == 71
    assert sampled["times"][-1] == .35
    np.testing.assert_allclose(sampled["times"], np.arange(71) * .005, atol=1e-16, rtol=0)
    np.testing.assert_allclose(sampled["positions"], history_values(whole)["positions"], atol=1e-14, rtol=0)
    np.testing.assert_allclose(final["state"], whole["state"], atol=1e-14, rtol=0)
