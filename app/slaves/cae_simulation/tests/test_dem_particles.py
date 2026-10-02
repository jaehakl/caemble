"""Independent mechanics checks for the spherical, rotational DEM formulation."""

from tests.particle_fixtures import setup_particles

import numpy as np
import pytest

from app.methods.geometry import TriangularMesh
from app.methods.particles.sampling import SurfaceQuery
from app.solvers.dem.formulation import DemStepper, contact_force


def evolve(stepper, state, duration, dt):
    time = 0.0
    while time < duration - 1e-14:
        state, used = stepper(state, min(dt, duration - time))
        time += used
    return state


@pytest.mark.validation
@pytest.mark.parametrize("dt", [2e-4, 1e-4])
def test_different_mass_collision_matches_elastic_solution(dt):
    model, state = setup_particles([[-1.01, 0, 0], [1.01, 0, 0]], [[1, 0, 0], [-1, 0, 0]], mass=[1, 2])
    result = evolve(DemStepper(model, []), state, .065, dt)
    np.testing.assert_allclose(result["velocity"][:, 0], [-5 / 3, 1 / 3], atol=2e-3)
    np.testing.assert_allclose(np.sum(model["mass"][:, None] * result["velocity"], axis=0), [-1, 0, 0], atol=1e-12)


@pytest.mark.validation
def test_contact_damping_dissipates_energy_and_refines():
    model, state = setup_particles([[-1.01, 0, 0], [1.01, 0, 0]], [[1, 0, 0], [-1, 0, 0]], damping=15)
    results = [evolve(DemStepper(model, []), state, .065, dt) for dt in (4e-4, 2e-4, 1e-4)]
    energies = [.5 * np.sum(item["velocity"]**2) for item in results]
    assert all(0 < value < 1 for value in energies)
    assert abs(energies[2] - energies[1]) < abs(energies[1] - energies[0])


def test_tangential_spring_work_is_recoverable_and_dashpot_work_is_not():
    normal, speed = np.array([0., 0., 1.]), np.array([.2, 0., 0.])
    coefficients = [1e4, 2500, 0, 0, .6, .5]
    _, memory, lost = contact_force(normal, .01, speed, coefficients, None, 1e-4)
    assert np.linalg.norm(memory["displacement"]) > 0
    assert lost == 0
    coefficients[3] = 2
    _, _, lost = contact_force(normal, .01, speed, coefficients, None, 1e-4)
    assert lost == pytest.approx(2 * .2**2 * 1e-4)


def floor_wall(normal=(0, 0, 1)):
    normal = np.asarray(normal, dtype=float)
    tangent = np.cross([0, 1, 0], normal)
    vertices = np.array([-10 * tangent - [0, 10, 0], 10 * tangent - [0, 10, 0],
                         10 * tangent + [0, 10, 0], -10 * tangent + [0, 10, 0]])
    mesh = TriangularMesh(vertices, np.array([[0, 1, 2], [0, 2, 3]]), ())
    return {"id": "floor", "materialIndex": 0, "query": SurfaceQuery(mesh)}


@pytest.mark.validation
def test_gravity_floor_rebound_and_triangle_seam_contact():
    model, state = setup_particles([[0, 0, .2]], [[0, 0, 0]], radius=[.1], gravity=[0, 0, -9.81], damping=5)
    stepper = DemStepper(model, [floor_wall()])
    seen_upward = False
    for _ in range(1000):
        state, _ = stepper(state, 2e-4)
        assert state["positions"][0, 2] > 0
        assert len(state["contactHistory"]) <= 1
        seen_upward |= state["velocity"][0, 2] > .1
    assert seen_upward


def test_reordering_preserves_contact_history_and_pair_response():
    model, state = setup_particles([[-.99, 0, 0], [.99, 0, 0]], [[.1, .3, 0], [-.1, -.2, 0]], friction=(.5, .3))
    stepper = DemStepper(model, [])
    state, _ = stepper(state, 1e-4)
    expected, _ = stepper(state, 1e-4)
    order = np.array([1, 0])
    reordered_model = {name: value[order] if name in {"mass", "radius", "inertia", "particleIds", "materialIndices"} else value
                       for name, value in model.items()}
    reordered = {name: value[order] if name in {"positions", "velocity", "angularVelocity"} else value
                 for name, value in state.items()}
    actual, _ = DemStepper(reordered_model, [])(reordered, 1e-4)
    for name in ("positions", "velocity", "angularVelocity"):
        np.testing.assert_allclose(actual[name][order], expected[name], atol=1e-14)
    assert actual["contactHistory"].keys() == expected["contactHistory"].keys()
    for key in expected["contactHistory"]:
        np.testing.assert_allclose(actual["contactHistory"][key]["displacement"], expected["contactHistory"][key]["displacement"])


@pytest.mark.validation
def test_incline_stick_means_rolling_not_a_stationary_sphere():
    angle = .25
    normal = np.array([np.sin(angle), 0, np.cos(angle)])
    tangent = np.array([np.cos(angle), 0, -np.sin(angle)])
    model, state = setup_particles([normal * (.1 - 9.81 * np.cos(angle) / 1e4)], [[0, 0, 0]],
                                  radius=[.1], friction=(.6, .5), damping=10, gravity=[0, 0, -9.81])
    stepper = DemStepper(model, [floor_wall(normal)])
    early = evolve(stepper, state, .15, 2e-4)
    result = evolve(stepper, early, .2, 2e-4)
    acceleration = np.dot(result["velocity"][0] - early["velocity"][0], tangent) / .2
    assert acceleration == pytest.approx(5 / 7 * 9.81 * np.sin(angle), rel=.035)
    arm = -normal * np.dot(result["positions"][0], normal)
    contact_speed = result["velocity"][0] + np.cross(result["angularVelocity"][0], arm)
    assert abs(np.dot(contact_speed, tangent)) < .005


@pytest.mark.validation
def test_incline_above_static_limit_slips():
    angle = .5
    normal = np.array([np.sin(angle), 0, np.cos(angle)])
    tangent = np.array([np.cos(angle), 0, -np.sin(angle)])
    model, state = setup_particles([normal * (.1 - 9.81 * np.cos(angle) / 1e4)], [[0, 0, 0]],
                                  radius=[.1], friction=(.02, .01), damping=10, gravity=[0, 0, -9.81])
    result = evolve(DemStepper(model, [floor_wall(normal)]), state, .15, 2e-4)
    arm = -normal * np.dot(result["positions"][0], normal)
    assert np.dot(result["velocity"][0] + np.cross(result["angularVelocity"][0], arm), tangent) > .1
