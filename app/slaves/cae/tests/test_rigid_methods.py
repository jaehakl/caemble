"""Batched rigid-body conventions, independent dynamics and dense-output checks."""

from copy import deepcopy

import numpy as np
import pytest
from scipy.integrate import solve_ivp
from scipy.spatial.transform import Rotation

from app.methods.rigid import (
    accumulate_wrenches,
    angular_velocity,
    apply_world_inertia,
    interpolate_step,
    local_to_world_points,
    midpoint_step,
    point_velocities,
    quaternion_exp,
    quaternion_from_matrix,
    quaternion_multiply,
    quaternion_to_matrix,
    world_to_local_points,
)


def initial_state():
    inertia = np.array([[[1., .12, -.08], [.12, 2., .15], [-.08, .15, 3.]]])
    orientation = quaternion_exp(np.array([[.2, -.3, .5]]))
    momentum = apply_world_inertia(orientation, inertia, np.array([[.7, 1.1, 1.5]]))
    state = {"position": np.array([[1., 2., 3.]]), "velocity": np.array([[.1, -.2, .3]]),
             "orientation": orientation, "angularMomentum": momentum}
    return state, inertia


def reference_rotation(state, inertia, time, loaded):
    """High-accuracy quaternion ODE reference, independent of the Lie step."""
    inverse = np.linalg.inv(inertia[0])
    arm, force, torque = np.array([.2, -.1, .3]), np.array([.4, .5, -.3]), np.array([.1, -.2, .05])

    def derivative(_time, values):
        w, vector = values[0], values[1:4]
        matrix = Rotation.from_quat(values[:4], scalar_first=True).as_matrix()
        omega = matrix @ inverse @ matrix.T @ values[4:]
        q_rate = .5 * np.r_[-omega @ vector, w * omega + np.cross(omega, vector)]
        moment = torque + np.cross(matrix @ arm, force) if loaded else np.zeros(3)
        return np.r_[q_rate, moment]

    values = np.r_[state["orientation"][0], state["angularMomentum"][0]]
    solved = solve_ivp(derivative, (0., time), values, method="DOP853", rtol=2e-12, atol=2e-13)
    assert solved.success
    final = solved.y[:, -1]
    return Rotation.from_quat(final[:4], scalar_first=True).as_matrix(), final[4:]


def advance(state, inverse, dt, loaded):
    settings = {"force": np.zeros((1, 3)), "torque": np.zeros((1, 3))}
    if loaded:
        settings.update(torque=np.array([[.1, -.2, .05]]), attachment_body_indices=np.array([0]),
                        attachment_arms=np.array([[.2, -.1, .3]]), attachment_forces=np.array([[.4, .5, -.3]]))
    return midpoint_step(state, np.array([2.]), inverse, dt, **settings)


def test_quaternion_batch_conversion_and_composition_at_zero_pi_and_full_turns():
    vectors = np.array([[0., 0., 0.], [1e-13, -2e-13, 3e-13],
                        [np.pi, 0., 0.], [0., np.pi, 0.], [0., 0., np.pi],
                        [0., 0., 2*np.pi], [4., -7., 9.]])
    quaternions = quaternion_exp(vectors)
    matrices = Rotation.from_rotvec(vectors).as_matrix()
    np.testing.assert_allclose(quaternion_to_matrix(quaternions), matrices, atol=2e-15)
    np.testing.assert_allclose(quaternion_to_matrix(quaternion_from_matrix(matrices)), matrices, atol=2e-15)
    increment = quaternion_exp([.3, -.7, .2])
    composed = quaternion_multiply(increment, quaternions)
    np.testing.assert_allclose(quaternion_to_matrix(composed), quaternion_to_matrix(increment) @ matrices, atol=2e-15)
    reshaped = matrices[:6].reshape(2, 3, 3, 3)
    np.testing.assert_allclose(quaternion_to_matrix(quaternion_from_matrix(reshaped)), reshaped, atol=2e-15)


def test_sparse_points_velocities_and_loads_use_world_com_and_selected_body():
    positions = np.array([[2., -1., 3.], [-5., 6., 1.], [9., 8., 7.]])
    orientations = quaternion_exp([[0., 0., np.pi/2], [.1, .2, .3], [0., 0., 0.]])
    indices = np.array([2, 0, 2, 0])
    local = np.array([[1., 2., 3.], [2., 0., 0.], [-1., 0., 0.], [0., 2., 0.]])
    world = local_to_world_points(positions, orientations, local, indices)
    expected_arms = np.array([[1., 2., 3.], [0., 2., 0.], [-1., 0., 0.], [-2., 0., 0.]])
    np.testing.assert_allclose(world, positions[indices] + expected_arms, atol=1e-14)
    np.testing.assert_allclose(world_to_local_points(positions, orientations, world, indices), local, atol=1e-14)
    velocities = np.array([[1., 0., 0.], [0., 0., 0.], [0., 2., 0.]])
    omega = np.array([[0., 0., 3.], [1., 0., 0.], [0., 0., -2.]])
    expected = velocities[indices] + np.cross(omega[indices], expected_arms)
    np.testing.assert_allclose(point_velocities(positions, velocities, omega, world, indices), expected, atol=1e-14)
    forces = np.array([[0., 1., 0.], [0., 0., 2.], [1., 0., 0.], [0., 0., 3.]])
    pure = np.array([[.1, .2, .3], [0., 0., 0.], [-.1, 0., 0.], [0., .5, 0.]])
    force, moment = accumulate_wrenches(3, indices, forces, moments=pure, arms=expected_arms)
    np.testing.assert_allclose(force, [[0., 0., 5.], [0., 0., 0.], [1., 1., 0.]])
    np.testing.assert_allclose(moment, [[4., 6.5, 0.], [0., 0., 0.], [-3., .2, 1.3]])


def test_off_diagonal_inertia_applies_world_axes_and_recovers_omega():
    state, inertia = initial_state()
    expected = np.array([[.7, 1.1, 1.5]])
    actual = angular_velocity(state["orientation"], np.linalg.inv(inertia), state["angularMomentum"])
    np.testing.assert_allclose(actual, expected, atol=1e-15)
    matrix = Rotation.from_quat(state["orientation"][0], scalar_first=True).as_matrix()
    np.testing.assert_allclose(state["angularMomentum"][0], matrix @ inertia[0] @ matrix.T @ expected[0], atol=1e-15)


def test_free_fall_dense_output_is_exact_and_inputs_remain_read_only():
    mass = np.array([2., 5.])
    gravity = np.array([1., -2., -9.81])
    state = {"position": np.array([[3., 2., 1.], [-1., -2., 3.]]),
             "velocity": np.array([[1., 2., 3.], [0., 1., -2.]]),
             "orientation": np.tile([1., 0., 0., 0.], (2, 1)), "angularMomentum": np.zeros((2, 3))}
    saved = deepcopy(state)
    for value in state.values():
        value.flags.writeable = False
    step = .37
    result, stages = midpoint_step(state, mass, np.tile(np.eye(3), (2, 1, 1)), step,
                                   force=mass[:, None] * gravity, torque=np.zeros((2, 3)))
    for fraction in (0., .013, .5, .81, 1.):
        sample = interpolate_step(state, stages, step, fraction)
        time = step * fraction
        np.testing.assert_allclose(sample["position"], saved["position"] + time * saved["velocity"] + .5 * time**2 * gravity, atol=1e-15)
        np.testing.assert_allclose(sample["velocity"], saved["velocity"] + time * gravity, atol=1e-15)
        for name in state:
            np.testing.assert_array_equal(state[name], saved[name])
    for name in result:
        np.testing.assert_array_equal(interpolate_step(state, stages, step, 1.)[name], result[name])


def test_attached_force_uses_rotated_midpoint_arm_and_adds_translation():
    state = {"position": np.zeros((1, 3)), "velocity": np.zeros((1, 3)),
             "orientation": np.array([[1., 0., 0., 0.]]), "angularMomentum": np.array([[0., 0., 1.]])}
    dt = .2
    result, _ = midpoint_step(state, np.array([2.]), np.eye(3)[None], dt,
                              force=np.zeros((1, 3)), torque=np.array([[0., 0., .3]]),
                              attachment_body_indices=np.array([0]), attachment_arms=np.array([[1., 0., 0.]]),
                              attachment_forces=np.array([[0., 2., 0.]]))
    np.testing.assert_allclose(result["angularMomentum"], [[0., 0., 1 + dt * (.3 + 2 * np.cos(dt/2))]], atol=1e-15)
    np.testing.assert_allclose(result["velocity"], [[0., dt, 0.]], atol=1e-15)
    np.testing.assert_allclose(result["position"], [[0., .5 * dt**2, 0.]], atol=1e-15)


@pytest.mark.parametrize("loaded", [False, True])
def test_asymmetric_rotation_and_dense_output_converge_at_second_order(loaded):
    original, inertia = initial_state()
    inverse = np.linalg.inv(inertia)
    errors, dense_errors, energy_errors = [], [], []
    reference, reference_momentum = reference_rotation(original, inertia, 2., loaded)
    dense_reference, dense_momentum = reference_rotation(original, inertia, 1.0137, loaded)
    initial_energy = .5 * np.sum(original["angularMomentum"] * angular_velocity(original["orientation"], inverse, original["angularMomentum"]))
    for dt in (.04, .02, .01):
        state = deepcopy(original)
        for index in range(round(2. / dt)):
            previous = state
            state, stages = advance(state, inverse, dt, loaded)
            if index * dt <= 1.0137 < (index + 1) * dt:
                dense = interpolate_step(previous, stages, dt, (1.0137 - index * dt) / dt)
        matrix = quaternion_to_matrix(state["orientation"])[0]
        errors.append(np.linalg.norm(Rotation.from_matrix(matrix @ reference.T).as_rotvec()) + np.linalg.norm(state["angularMomentum"][0] - reference_momentum))
        dense_matrix = quaternion_to_matrix(dense["orientation"])[0]
        dense_errors.append(np.linalg.norm(Rotation.from_matrix(dense_matrix @ dense_reference.T).as_rotvec()) + np.linalg.norm(dense["angularMomentum"][0] - dense_momentum))
        np.testing.assert_allclose(matrix.T @ matrix, np.eye(3), atol=1e-12)
        np.testing.assert_allclose(np.linalg.norm(state["orientation"], axis=-1), 1., atol=1e-14)
        if not loaded:
            np.testing.assert_array_equal(state["angularMomentum"], original["angularMomentum"])
            energy = .5 * np.sum(state["angularMomentum"] * angular_velocity(state["orientation"], inverse, state["angularMomentum"]))
            energy_errors.append(abs((energy - initial_energy) / initial_energy))
    assert min(np.asarray(errors[:-1]) / errors[1:]) > 3.5
    assert min(np.asarray(dense_errors[:-1]) / dense_errors[1:]) > 3.5
    if not loaded:
        assert energy_errors[-1] < 1e-4
        assert min(np.asarray(energy_errors[:-1]) / energy_errors[1:]) > 3.5


def test_dense_rotation_preserves_full_turns_between_identical_end_orientations():
    state = {"position": np.zeros((1, 3)), "velocity": np.zeros((1, 3)),
             "orientation": np.array([[1., 0., 0., 0.]]), "angularMomentum": np.array([[0., 0., 8*np.pi]])}
    result, stages = midpoint_step(state, np.ones(1), np.eye(3)[None], 1., force=np.zeros((1, 3)), torque=np.zeros((1, 3)))
    np.testing.assert_allclose(quaternion_to_matrix(result["orientation"])[0], np.eye(3), atol=2e-15)
    sample = interpolate_step(state, stages, 1., .125)
    np.testing.assert_allclose(quaternion_to_matrix(sample["orientation"])[0], np.diag([-1., -1., 1.]), atol=2e-15)


def test_split_sequence_and_observations_leave_batched_dynamics_identical():
    original, inertia = initial_state()
    original = {name: np.repeat(values, 3, axis=0) for name, values in original.items()}
    original["angularMomentum"] *= np.array([[1.], [.7], [1.4]])
    inverse = np.repeat(np.linalg.inv(inertia), 3, axis=0)
    increments = [.01, .01, .007, .003, .01, .006, .004, .01]
    loads = {"force": np.array([[.1, .2, .3], [-.5, .2, .6], [.7, -.3, .1]]),
             "torque": np.array([[.1, -.1, .3], [.2, .5, .7], [-.4, .2, -.3]]),
             "attachment_body_indices": np.array([2, 0, 2]),
             "attachment_arms": np.array([[.1, .2, .3], [-.1, .3, .2], [.5, .4, -.2]]),
             "attachment_forces": np.array([[.4, .5, -.3], [1., 2., 3.], [-.1, .5, -.3]])}
    continuous = deepcopy(original)
    for dt in increments:
        continuous, _ = midpoint_step(continuous, np.array([2., 3., 4.]), inverse, dt, **loads)
    split = deepcopy(original)
    for window in (increments[:3], increments[3:6], increments[6:]):
        split = deepcopy(split)
        for dt in window:
            previous = split
            split, stages = midpoint_step(split, np.array([2., 3., 4.]), inverse, dt, **loads)
            for fraction in (.1, .3, .71, .9):
                interpolate_step(previous, stages, dt, fraction)
    for name in continuous:
        np.testing.assert_array_equal(split[name], continuous[name])


def test_batched_step_is_covariant_under_a_rigid_change_of_world_coordinates():
    state, inertia = initial_state()
    inverse = np.linalg.inv(inertia)
    frame = quaternion_exp([.9, -.7, .3])
    matrix = quaternion_to_matrix(frame)
    offset = np.array([7., -3., 2.])
    changed = {"position": state["position"] @ matrix.T + offset,
               "velocity": state["velocity"] @ matrix.T,
               "orientation": quaternion_multiply(frame, state["orientation"]),
               "angularMomentum": state["angularMomentum"] @ matrix.T}
    force, torque = np.array([[1., 2., 3.]]), np.array([[-.2, .3, .4]])
    attachments = {"attachment_body_indices": np.array([0]), "attachment_arms": np.array([[.2, -.1, .3]])}
    first, _ = midpoint_step(state, np.array([2.]), inverse, .013, force=force, torque=torque,
                            attachment_forces=force, **attachments)
    second, _ = midpoint_step(changed, np.array([2.]), inverse, .013, force=force @ matrix.T,
                             torque=torque @ matrix.T, attachment_forces=force @ matrix.T, **attachments)
    np.testing.assert_allclose(second["position"], first["position"] @ matrix.T + offset, atol=2e-15)
    np.testing.assert_allclose(second["velocity"], first["velocity"] @ matrix.T, atol=2e-15)
    np.testing.assert_allclose(second["angularMomentum"], first["angularMomentum"] @ matrix.T, atol=2e-15)
    np.testing.assert_allclose(quaternion_to_matrix(second["orientation"]), matrix @ quaternion_to_matrix(first["orientation"]), atol=2e-15)
