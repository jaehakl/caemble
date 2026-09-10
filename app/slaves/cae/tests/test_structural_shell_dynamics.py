"""셸의 실제 두께 운동, 질량 없는 drilling 방향, 하중을 받는 큰 회전을 검증한다."""

from copy import deepcopy
from itertools import product

import numpy as np
from app.solvers.structural_mechanics.analysis import (
    initial_solution,
    initialize_acceleration,
    transient_step,
)
from app.solvers.structural_mechanics.continuum import shape_functions
from app.solvers.structural_mechanics.formulation import (
    inertial_response,
    prepare_matrices,
)
from app.solvers.structural_mechanics.model import Element, StructuralModel
from app.solvers.structural_mechanics.rotations import rotation_exp
from app.solvers.structural_mechanics.shells import (
    isotropic_section,
    laminate_section,
    shell4_director_mass,
    shell4_mass_moments,
    shell4_matrices,
    shell_frame,
)


def test_director_mass_matches_layer_velocity_energy_and_has_no_drilling_inertia():
    # 밀도가 다른 비대칭 적층은 병진↔회전의 mass1 항까지 확인한다.
    plies = [
        {"thickness": thickness, "density": density, "angle": 0., "E1": 100.,
         "E2": 80., "nu12": .2, "G12": 30., "G13": 30., "G23": 25.}
        for thickness, density in [(.08, 2.), (.12, 5.)]
    ]
    section = laminate_section(plies)
    base = np.array([[-.5, -.4, 0.], [.5, -.4, 0.], [.6, .4, 0.], [-.5, .5, 0.]])
    coordinates = base @ rotation_exp(np.array([.2, -.7, .4])).T
    normal, moments = shell4_mass_moments(coordinates, section)
    initial_mass = shell4_director_mass(normal, moments, np.tile(np.eye(3), (4, 1, 1)))[0]
    np.testing.assert_allclose(initial_mass, shell4_matrices(coordinates, section)[1], atol=2e-16)
    orientations = np.array([rotation_exp(np.array([.2*i, -.1*i, .3])) for i in range(4)])
    mass, _ = shell4_director_mass(normal, moments, orientations)
    velocity = np.random.default_rng(8).normal(size=(4, 6))
    directors = orientations @ normal
    local, _ = shell_frame(coordinates)
    integrated_energy = 0.
    for point in product((-1 / np.sqrt(3), 1 / np.sqrt(3)), repeat=2):
        N, derivatives = shape_functions("quad4", np.asarray(point))
        area = np.linalg.det(local.T @ derivatives)
        bottom = -section["thickness"] / 2
        for ply in plies:
            half = ply["thickness"] / 2
            for zeta in (-1 / np.sqrt(3), 1 / np.sqrt(3)):
                z = bottom + half * (1 + zeta)
                material_velocity = N @ (velocity[:, :3] + z * np.cross(velocity[:, 3:], directors))
                integrated_energy += .5 * ply["density"] * half * area * (material_velocity @ material_velocity)
            bottom += ply["thickness"]
    np.testing.assert_allclose(.5 * velocity.ravel() @ mass @ velocity.ravel(), integrated_energy, rtol=2e-14)
    np.testing.assert_allclose(mass, mass.T, atol=2e-17)
    for node in range(4):
        drilling = np.zeros((4, 6))
        drilling[node, 3:] = directors[node]
        np.testing.assert_allclose(mass @ drilling.ravel(), 0., atol=2e-17)
    assert np.count_nonzero(np.linalg.eigvalsh(mass) < 1e-12) == 4


def test_director_mass_derivative_matches_spatial_rotation_and_is_drilling_invariant():
    coordinates = np.array([[-.5, -.4, 0.], [.5, -.4, 0.], [.5, .4, 0.], [-.5, .4, 0.]])
    normal, moments = shell4_mass_moments(coordinates, isotropic_section(100., .25, .2, 2.))
    orientations = np.array([rotation_exp(np.array([.3, -.2*i, .4*i])) for i in range(4)])
    mass, derivatives = shell4_director_mass(normal, moments, orientations, True)
    for node in range(4):
        for axis in range(3):
            plus, minus = orientations.copy(), orientations.copy()
            delta = np.eye(3)[axis] * 1e-6
            plus[node] = rotation_exp(delta) @ plus[node]
            minus[node] = rotation_exp(-delta) @ minus[node]
            difference = (
                shell4_director_mass(normal, moments, plus)[0]
                - shell4_director_mass(normal, moments, minus)[0]
            ) / 2e-6
            np.testing.assert_allclose(derivatives[6*node+3+axis], difference, rtol=1e-7, atol=2e-13)
        spun = orientations.copy()
        spun[node] = rotation_exp(.73 * (orientations[node] @ normal)) @ spun[node]
        np.testing.assert_allclose(shell4_director_mass(normal, moments, spun)[0], mass, atol=2e-17)
    np.testing.assert_array_equal(derivatives.reshape(4, 6, 24, 24)[:, :3], 0.)


def test_loaded_three_axis_rotating_shell_refines_work_and_angular_impulse_balance():
    points = np.array([[-.5, -.4, 0.], [.5, -.4, 0.], [.5, .4, 0.], [-.5, .4, 0.]])
    element = Element("shell4", np.arange(4), {"model": "mechanics.linear-isotropic@1"}, isotropic_section(100., .25, .2, 2.))
    model = StructuralModel(np.arange(4), points, [element], np.arange(24), np.empty(0, dtype=int), np.zeros(24))
    K, M, C, prepared = prepare_matrices(model)
    initial = initial_solution(model)
    Q = rotation_exp(np.array([1.1, -.6, .3]))
    initial.displacement[:, :3] = points @ Q.T - points
    initial.orientations[:] = Q
    omega = np.array([1.2, .7, -.4])
    initial.velocity[:, :3] = np.cross(omega, points @ Q.T)
    initial.velocity[:, 3:] = omega
    load = np.zeros((4, 6))
    load[2, :3] = Q @ np.array([.01, -.01, .04])
    load[0, :3] = -load[2, :3]
    initial = initialize_acceleration(model, initial, prepared, K, M, C, load.ravel(), True)

    def angular_momentum(state):
        current_mass = inertial_response(model, state.displacement, state.orientations, state.velocity, state.acceleration, prepared, M, True)[1]
        momentum = np.asarray(current_mass @ state.velocity.ravel()).reshape(-1, 6)
        return np.sum(np.cross(points + state.displacement[:, :3], momentum[:, :3]) + momentum[:, 3:], axis=0)

    initial_momentum = angular_momentum(initial)
    errors = []
    for dt in (.02, .01, .005):
        state = deepcopy(initial)
        impulse = np.zeros(3)
        for _ in range(round(.04 / dt)):
            old_torque = np.sum(np.cross(points + state.displacement[:, :3], load[:, :3]), axis=0)
            state = transient_step(model, state, prepared, K, M, C, load.ravel(), dt, 0., 1e-8, 15, True)
            new_torque = np.sum(np.cross(points + state.displacement[:, :3], load[:, :3]), axis=0)
            impulse += .5 * dt * (old_torque + new_torque)
        work = load.ravel() @ (state.displacement - initial.displacement).ravel()
        energy_error = abs(state.strain_energy + state.kinetic_energy - initial.strain_energy - initial.kinetic_energy - work) / initial.kinetic_energy
        momentum_error = np.linalg.norm(angular_momentum(state) - initial_momentum - impulse) / np.linalg.norm(initial_momentum)
        errors.append([energy_error, momentum_error])
        # 무질량 방향의 인공 spin이 자라지 않아야 한다. 실제 초기 속도는 약1.45rad/s다.
        assert np.max(np.linalg.norm(state.velocity[:, 3:], axis=1)) < 2.
    errors = np.asarray(errors)
    assert np.all(errors[1:] < .3 * errors[:-1])
    assert errors[-1, 0] < 2e-5
    assert errors[-1, 1] < 1e-5
