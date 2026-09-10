"""기울어진 축의 회전 조인트: 자세, 속도, 가상일과 실제 시간 적분."""

from copy import deepcopy

import numpy as np
import pytest

from app.solvers.structural_mechanics.analysis import (
    _link_geometric_matrix,
    apply_increment,
    initial_solution,
    initialize_acceleration,
    kinematic_rates,
    transient_step,
)
from app.solvers.structural_mechanics.constraints import (
    constraint_transform,
    enforce_links,
    spring_gradient,
)
from app.solvers.structural_mechanics.formulation import (
    inertial_response,
    prepare_matrices,
    structural_response,
)
from app.solvers.structural_mechanics.model import StructuralModel
from app.solvers.structural_mechanics.rotations import rotation_exp, rotation_log


def joint_model():
    points = np.array([[0., 0., 0.], [.4, 0., 0.], [.4, 1., .2]])
    model = StructuralModel(np.arange(3), points, [], np.arange(18), np.empty(0, dtype=int), np.zeros((3, 6)))
    model.links = [(0, 1, np.array([0, 1, 2, 4, 5])), (1, 2, np.arange(6))]
    return model


def test_tilted_revolute_pose_and_virtual_increment_follow_master_axis():
    model = joint_model()
    u = np.zeros((3, 6)); u[1, 3] = 9.2
    R = np.tile(np.eye(3), (3, 1, 1)); R[0] = rotation_exp(np.array([.3, .8, -.4]))
    enforce_links(model, u, R)
    expected = R[0] @ rotation_exp(np.array([9.2, 0., 0.]))
    np.testing.assert_allclose(R[1], expected, atol=1e-14)
    np.testing.assert_allclose(R[2], expected, atol=1e-14)
    np.testing.assert_allclose(model.points[2] + u[2, :3], R[0] @ model.points[1] + expected @ (model.points[2] - model.points[1]), atol=1e-14)
    T = constraint_transform(model, R)
    direction = np.array([.1, -.2, .3, .2, -.1, .4, .7])
    physical = (T @ direction).reshape(3, 6)
    step = 1e-6
    up, Rp = apply_increment(model, u, R, step * physical.ravel())
    um, Rm = apply_increment(model, u, R, -step * physical.ravel())
    np.testing.assert_allclose((up[:, :3] - um[:, :3]) / (2 * step), physical[:, :3], atol=2e-9)
    spins = np.array([rotation_log(a @ b.T) / (2 * step) for a, b in zip(Rp, Rm)])
    np.testing.assert_allclose(spins, physical[:, 3:], atol=2e-9)
    np.testing.assert_allclose((up[1, 3] - um[1, 3]) / (2 * step), direction[-1], atol=2e-9)


def test_revolute_velocity_acceleration_and_newmark_jacobians():
    model = joint_model()
    u = np.zeros((3, 6)); u[1, 3] = 2.3
    R = np.tile(np.eye(3), (3, 1, 1)); R[0] = rotation_exp(np.array([.2, .6, -.3]))
    enforce_links(model, u, R)
    v, a = np.zeros_like(u), np.zeros_like(u)
    v[0], a[0] = [.1, .2, -.1, .4, -.3, .7], [.3, -.2, .1, -.2, .5, .1]
    rates = {1: (1.3, -.4)}
    T = constraint_transform(model, R)
    actual_v, actual_a, V, A = kinematic_rates(model, R, v, a, transform=T, velocity_factor=7., acceleration_factor=13., joint_rates=rates)
    axis = R[0][:, 0]
    np.testing.assert_allclose(actual_v[1, 3:], v[0, 3:] + 1.3 * axis)
    np.testing.assert_allclose(actual_a[1, 3:], a[0, 3:] - .4 * axis + np.cross(v[0, 3:], 1.3 * axis))
    direction = np.array([.2, -.1, .3, -.3, .1, .2, .6])
    physical = (T @ direction).reshape(3, 6)
    step = 1e-6
    _, Rp = apply_increment(model, u, R, step * physical.ravel())
    _, Rm = apply_increment(model, u, R, -step * physical.ravel())
    vp, ap, _, _ = kinematic_rates(model, Rp, v + 7 * step * physical, a + 13 * step * physical, joint_rates={1: (1.3 + 7 * step * direction[-1], -.4 + 13 * step * direction[-1])})
    vm, am, _, _ = kinematic_rates(model, Rm, v - 7 * step * physical, a - 13 * step * physical, joint_rates={1: (1.3 - 7 * step * direction[-1], -.4 - 13 * step * direction[-1])})
    np.testing.assert_allclose(V @ direction, ((vp - vm) / (2 * step)).ravel(), atol=2e-8)
    np.testing.assert_allclose(A @ direction, ((ap - am) / (2 * step)).ravel(), atol=3e-8)


def test_geared_shaft_spring_conserves_casing_torque_and_virtual_work():
    model = joint_model()
    model.links[1] = (0, 2, np.array([0, 1, 2, 4, 5]))
    model.springs = [(9, 15, 1 / 3, 120., 0.)]
    _, _, _, prepared = prepare_matrices(model)
    u = np.zeros((3, 6)); u[1, 3], u[2, 3] = .7, 2.
    R = np.tile(np.eye(3), (3, 1, 1)); R[0] = rotation_exp(np.array([.5, -.8, .4]))
    enforce_links(model, u, R)
    force, tangent, _, _, _energy = structural_response(model, u, R, prepared, None, True)
    torque = 120 * (.7 - 2 / 3)
    expected = np.array([-(1 - 1 / 3), 1., -1 / 3])[:, None] * torque * R[0][:, 0]
    np.testing.assert_allclose(force.reshape(3, 6)[:, 3:], expected, atol=1e-12)
    np.testing.assert_allclose(expected.sum(axis=0), 0., atol=1e-12)
    T = constraint_transform(model, R)
    direction = np.array([0., 0., 0., .2, -.1, .3, .4, -.6])
    np.testing.assert_allclose(force @ (T @ direction), torque * (.4 + .6 / 3))
    reduced_tangent = T.T @ (tangent + _link_geometric_matrix(model, R, -force)) @ T
    step = 1e-6
    up, Rp = apply_increment(model, u, R, step * (T @ direction))
    um, Rm = apply_increment(model, u, R, -step * (T @ direction))
    fp = constraint_transform(model, Rp).T @ structural_response(model, up, Rp, prepared, None, True)[0]
    fm = constraint_transform(model, Rm).T @ structural_response(model, um, Rm, prepared, None, True)[0]
    np.testing.assert_allclose(reduced_tangent @ direction, (fp - fm) / (2 * step), atol=2e-8)


def test_tilted_revolute_rotor_keeps_unwrapped_spin_and_energy():
    model = joint_model()
    model.fixed = np.arange(6)
    model.masses = [(1, 1., np.eye(3) * .1), (2, 2., np.zeros((3, 3)))]
    K, M, C, prepared = prepare_matrices(model)
    solution = initial_solution(model)
    solution.orientations[0] = rotation_exp(np.array([.2, .8, -.4]))
    solution.displacement[1, 3] = 8.
    axis = solution.orientations[0][:, 0]
    solution.velocity[1, 3:] = 3. * axis
    solution = initialize_acceleration(model, solution, prepared, K, M, C, np.zeros(18), True)
    energy = solution.kinetic_energy
    for _ in range(20):
        solution = transient_step(model, solution, prepared, K, M, C, np.zeros(18), .03, 0., 1e-10, 12, True)
    np.testing.assert_allclose(solution.displacement[1, 3], 9.8, atol=2e-12)
    np.testing.assert_allclose(solution.orientations[1], solution.orientations[0] @ rotation_exp([9.8, 0., 0.]), atol=2e-12)
    np.testing.assert_allclose(solution.velocity[1, 3:], 3 * axis, atol=2e-12)
    np.testing.assert_allclose(solution.kinetic_energy, energy, rtol=2e-12)


@pytest.mark.parametrize("torque", [0., .05])
def test_free_tilting_base_and_spinning_rotor_conserve_energy_and_angular_momentum(torque):
    model = joint_model()
    model.masses = [(0, 2., np.diag([.5, .7, .8])), (1, .5, np.diag([.02, .04, .04])), (2, .3, np.zeros((3, 3)))]
    K, M, C, prepared = prepare_matrices(model)
    initial = initial_solution(model)
    initial.orientations[0] = rotation_exp([.3, .8, -.4])
    initial.displacement[1, 3] = 1.2
    initial.velocity[0, 3:] = [.3, -.4, .2]
    initial.velocity[1, 3:] = initial.velocity[0, 3:] + 1.3 * initial.orientations[0][:, 0]
    initial_force = torque * spring_gradient(model, initial.orientations, 9, -1, 0.)
    initial = initialize_acceleration(model, initial, prepared, K, M, C, initial_force, True)
    moving = inertial_response(model, initial.displacement, initial.orientations, initial.velocity, initial.acceleration, prepared, M, True)[1]
    momentum = (moving @ initial.velocity.ravel()).reshape(3, 6)
    initial_momentum = np.sum(np.cross(model.points + initial.displacement[:, :3], momentum[:, :3]) + momentum[:, 3:], axis=0)
    errors = []
    for dt in (.02, .01):
        current = deepcopy(initial)
        work, previous_rate = 0., 1.3
        for _ in range(round(.3 / dt)):
            current = transient_step(model, current, prepared, K, M, C, np.zeros(18), dt, 0., 1e-10, 15, True, joint_torques={1: torque})
            rate = current.orientations[0][:, 0] @ (current.velocity[1, 3:] - current.velocity[0, 3:])
            work += dt * torque * (previous_rate + rate) / 2
            previous_rate = rate
        moving = inertial_response(model, current.displacement, current.orientations, current.velocity, current.acceleration, prepared, M, True)[1]
        momentum = (moving @ current.velocity.ravel()).reshape(3, 6)
        final = np.sum(np.cross(model.points + current.displacement[:, :3], momentum[:, :3]) + momentum[:, 3:], axis=0)
        errors.append(abs(current.kinetic_energy - initial.kinetic_energy - work) / initial.kinetic_energy + np.linalg.norm(final - initial_momentum) / np.linalg.norm(initial_momentum))
        assert np.linalg.norm(current.orientations[0] - initial.orientations[0]) > .1
    assert errors[1] < .3 * errors[0] and errors[1] < 1e-5


def test_joint_actuator_work_equals_mechanical_energy_and_keeps_casing_reaction():
    model = joint_model()
    model.fixed = np.arange(6)
    model.masses = [(1, 1., np.eye(3) * .1), (2, 2., np.zeros((3, 3)))]
    K, M, C, prepared = prepare_matrices(model)
    solution = initial_solution(model)
    solution.orientations[0] = rotation_exp([.3, .8, -.4])
    torque = .2
    initial_torque = torque * spring_gradient(model, solution.orientations, 9, -1, 0.)
    solution = initialize_acceleration(model, solution, prepared, K, M, C, initial_torque, True)
    work, previous_rate = 0., 0.
    for _ in range(20):
        solution = transient_step(model, solution, prepared, K, M, C, np.zeros(18), .02, 0., 1e-10, 12, True, joint_torques={1: torque})
        axis = solution.orientations[0][:, 0]
        rate = axis @ (solution.velocity[1, 3:] - solution.velocity[0, 3:])
        work += .02 * torque * (previous_rate + rate) / 2
        previous_rate = rate
    np.testing.assert_allclose(solution.kinetic_energy, work, rtol=1e-9)
    # 케이싱에는 -torque가 전달되므로 지지점은 반대 방향 +torque로 버팁니다.
    np.testing.assert_allclose(solution.reaction[0, 3:] @ axis, torque, atol=1e-10)
