"""Physical contact checks on oriented canonical triangle surfaces."""

from types import SimpleNamespace

import manifold3d
import numpy as np
import pytest

from app.methods.rigid import midpoint_step
from app.solvers.rigid_body.contact import ContactStepper


def case(*, friction=(0.0, 0.0), restitution=0.0, height=0.5, speed=0.0, fixed=True, solids=None):
    solids = solids or [
        manifold3d.Manifold.cube((10.0, 10.0, 1.0), True),
        manifold3d.Manifold.cube((1.0, 1.0, 1.0), True),
    ]
    meshes = [solid.to_mesh64() for solid in solids]
    vertices = [np.asarray(mesh.vert_properties)[:, :3] for mesh in meshes]
    offsets = np.cumsum([0, *map(len, vertices)])
    faces = [np.asarray(mesh.tri_verts, dtype=np.int64) for mesh in meshes]
    count = len(solids)
    coefficients = np.zeros((count, count, 3))
    coefficients[:] = [*friction, restitution]
    model = {
        "masses": np.ones(count),
        "inverseInertias": np.tile(np.eye(3) * 6.0, (count, 1, 1)),
        "vertices": np.concatenate(vertices),
        "triangles": np.concatenate([f + offset for f, offset in zip(faces, offsets, strict=False)]),
        "vertexOffsets": offsets,
        "triangleOffsets": np.cumsum([0, *map(len, faces)]),
        "localCenters": np.zeros((count, 3)),
        "static": np.array([fixed, *[False] * (count - 1)]),
        "force": np.array([[0.0, 0.0, 0.0], *[[0.0, 0.0, -9.81]] * (count - 1)]),
        "torque": np.zeros((count, 3)),
        "attachmentBodyIndices": np.zeros(0, dtype=int),
        "attachmentArms": np.zeros((0, 3)),
        "attachmentForces": np.zeros((0, 3)),
        "contactCoefficients": coefficients,
        "bodyIds": ["floor", *[f"block-{i}" for i in range(count - 1)]],
    }
    state = {
        "position": np.array([[0.0, 0.0, -0.5], *[[0.0, 0.0, height + i] for i in range(count - 1)]]),
        "velocity": np.array([[0.0, 0.0, 0.0], *[[speed, 0.0, 0.0]] * (count - 1)]),
        "orientation": np.tile([1.0, 0.0, 0.0, 0.0], (count, 1)),
        "angularMomentum": np.zeros((count, 3)),
    }
    invocation = SimpleNamespace(config={"initializations": []})
    return model, state, invocation


def advance(model, state, invocation, duration, dt=0.005, saved=None):
    stepper = ContactStepper(invocation, model, {**state, "time": 0.0, **(saved or {})}, midpoint_step)
    elapsed = 0.0
    while elapsed < duration - 1e-14:
        end = min(duration, elapsed + dt)
        stepper.steps = 0
        while elapsed < end - 1e-14:
            step, state, _ = stepper.advance(state, end - elapsed)
            elapsed += step
    return state, stepper


def test_frictionless_resting_and_sliding_preserve_normal_support():
    model, state, invocation = case(speed=1.0)
    result, stepper = advance(model, state, invocation, 0.1)
    np.testing.assert_allclose(result["position"][0], state["position"][0], atol=0)
    np.testing.assert_allclose(result["velocity"][1], [1.0, 0.0, 0.0], atol=1e-7)
    assert result["position"][1, 2] == pytest.approx(0.5, abs=1e-7)
    assert stepper.dissipation == 0.0


def test_kinetic_friction_matches_analytic_deceleration():
    model, state, invocation = case(speed=2.0, friction=(0.6, 0.4))
    result, stepper = advance(model, state, invocation, 0.1)
    assert result["velocity"][1, 0] == pytest.approx(2.0 - 0.4 * 9.81 * 0.1, rel=0.01)
    assert stepper.dissipation > 0


def test_static_friction_holds_below_threshold_and_slips_above():
    for force, moves in [(4.0, False), (8.0, True)]:
        model, state, invocation = case(friction=(0.6, 0.4))
        model["force"][1, 0] = force
        result, _ = advance(model, state, invocation, 0.05)
        assert (result["velocity"][1, 0] > 0.01) == moves


def test_high_speed_impact_cannot_tunnel_through_floor():
    model, state, invocation = case(height=3.0, restitution=0.5)
    state["velocity"][1, 2] = -100.0
    model["force"][:] = 0.0
    result, _ = advance(model, state, invocation, 0.04, dt=0.04)
    assert result["position"][1, 2] >= 0.5 - 1e-7
    assert result["velocity"][1, 2] == pytest.approx(50.0, rel=0.01)


def test_initial_containment_is_rejected():
    model, state, invocation = case(height=-0.5)
    with pytest.raises(ValueError, match="initial rigid solids overlap"):
        advance(model, state, invocation, 0.01)


def test_hole_in_concave_solid_remains_open():
    ring = manifold3d.Manifold.cube((6.0, 6.0, 1.0), True) - manifold3d.Manifold.cube((2.0, 2.0, 2.0), True)
    model, state, invocation = case(
        solids=[ring, manifold3d.Manifold.cube((1.0, 1.0, 1.0), True)], height=2.0
    )
    state["velocity"][1, 2] = -10.0
    model["force"][:] = 0.0
    result, _ = advance(model, state, invocation, 0.4, dt=0.02)
    np.testing.assert_allclose(result["velocity"][1], [0.0, 0.0, -10.0], atol=1e-8)
    assert result["position"][1, 2] < -1.0


def test_crossed_thin_bars_have_edge_contacts_without_vertex_face_overlap():
    model, state, invocation = case(
        solids=[
            manifold3d.Manifold.cube((4.0, 0.2, 0.2), True),
            manifold3d.Manifold.cube((0.2, 4.0, 0.2), True),
        ],
        height=-0.3,
    )
    result, stepper = advance(model, state, invocation, 0.02)
    assert result["position"][1, 2] == pytest.approx(-0.3, abs=1e-7)
    assert len(stepper.history) >= 4


def test_stack_remains_supported_and_does_not_gain_energy():
    cubes = [
        manifold3d.Manifold.cube((10.0, 10.0, 1.0), True),
        *[manifold3d.Manifold.cube((1.0, 1.0, 1.0), True) for _ in range(2)],
    ]
    model, state, invocation = case(solids=cubes, friction=(0.6, 0.4))
    result, _ = advance(model, state, invocation, 0.1)
    np.testing.assert_allclose(result["position"], state["position"], atol=2e-7)
    np.testing.assert_allclose(result["velocity"], 0, atol=2e-7)


def test_contact_checkpoint_resume_and_branches_preserve_motion_and_dissipation():
    model, state, invocation = case(speed=2.0, friction=(0.6, 0.4))
    whole, total = advance(model, state, invocation, 0.1)
    first, checkpoint = advance(model, state, invocation, 0.05)
    saved = {
        "time": 0.05,
        "contactHistory": checkpoint.history,
        "frictionDissipation": checkpoint.dissipation,
        "maxPenetration": checkpoint.max_penetration,
    }
    resumed, final = advance(model, first, invocation, 0.05, saved=saved)
    branch, _ = advance(model, first, invocation, 0.05, saved=saved)
    for key in whole:
        np.testing.assert_allclose(resumed[key], whole[key], atol=2e-9)
        np.testing.assert_array_equal(resumed[key], branch[key])
    assert final.dissipation == pytest.approx(total.dissipation, abs=1e-10)
    assert total.dissipation == pytest.approx(0.5 * (4.0 - whole["velocity"][1, 0] ** 2), rel=0.001)


def test_rotating_corner_impact_has_finite_angular_response():
    from app.methods.rigid import quaternion_exp

    model, state, invocation = case(height=1.5, restitution=0.3)
    state["orientation"][1] = quaternion_exp(np.array([0.0, 0.3, 0.0]))
    state["angularMomentum"][1, 1] = 0.2
    state["velocity"][1, 2] = -15.0
    result, stepper = advance(model, state, invocation, 0.08, dt=0.01)
    assert np.isfinite(result["angularMomentum"]).all()
    assert np.linalg.norm(result["angularMomentum"][1]) > 0.1
    assert stepper.collision.penetration(result) <= stepper.settings["tolerance"]
    assert result["position"][1, 2] > 0.5


def test_sliding_stops_without_reversing_or_creating_energy():
    model, state, invocation = case(speed=0.2, friction=(0.6, 0.4))
    result, stepper = advance(model, state, invocation, 0.15)
    np.testing.assert_allclose(result["velocity"][1], 0, atol=1e-7)
    assert result["position"][1, 0] > 0
    assert stepper.dissipation <= 0.5 * 0.2**2 + 1e-6


def test_touching_bodies_can_separate_without_adhesion():
    model, state, invocation = case()
    state["velocity"][1, 2] = 1.0
    model["force"][:] = 0.0
    result, _ = advance(model, state, invocation, 0.01)
    assert result["position"][1, 2] == pytest.approx(0.51)
    assert result["velocity"][1, 2] == pytest.approx(1.0)


def test_equal_mass_elastic_impact_exchanges_velocities_and_preserves_momentum():
    cubes = [manifold3d.Manifold.cube((1.0, 1.0, 1.0), True) for _ in range(2)]
    model, state, invocation = case(solids=cubes, fixed=False, restitution=1.0)
    state["position"][:] = [[-1.0, 0.0, 0.0], [1.0, 0.0, 0.0]]
    state["velocity"][:] = [[10.0, 0.0, 0.0], [-10.0, 0.0, 0.0]]
    model["force"][:] = 0.0
    result, stepper = advance(model, state, invocation, 0.1, dt=0.1)
    np.testing.assert_allclose(result["velocity"], -state["velocity"], atol=1e-7, rtol=0)
    np.testing.assert_allclose(result["velocity"].sum(axis=0), 0.0, atol=1e-10, rtol=0)
    assert np.sum(result["velocity"] ** 2) == pytest.approx(np.sum(state["velocity"] ** 2), rel=1e-8)
    assert stepper.dissipation == 0.0
