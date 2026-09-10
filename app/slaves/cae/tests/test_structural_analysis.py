"""조립부터 정적·고유치·시간 적분까지 이어지는 수치 검증입니다."""

from copy import deepcopy

import numpy as np
import pytest
from scipy import sparse

from app.solvers.structural_mechanics.analysis import (
    apply_increment,
    buckling_analysis,
    harmonic_analysis,
    initial_solution,
    initialize_acceleration,
    kinematic_rates,
    modal_analysis,
    solve_linear,
    static_analysis,
    transient_step,
)
from app.solvers.structural_mechanics.beam import isotropic_beam_section
from app.solvers.structural_mechanics.constraints import (
    constraint_transform,
    enforce_links,
)
from app.solvers.structural_mechanics.formulation import (
    inertial_response,
    prepare_matrices,
    strain_rate_damping,
)
from app.solvers.structural_mechanics.materials import isotropic_elasticity
from app.solvers.structural_mechanics.model import Element, StructuralModel
from app.solvers.structural_mechanics.rotations import rotation_exp
from app.solvers.structural_mechanics.shells import isotropic_section


def beam_model(segments=12, force=1.):
    length, E, nu, rho, area, second_moment = 2., 2e7, .3, 1000., .01, 1e-6
    points = np.column_stack((np.linspace(0., length, segments + 1), np.zeros((segments + 1, 2))))
    C, inertia = isotropic_beam_section(E, nu, rho, area, np.array([2 * second_moment, second_moment, second_moment]), np.array([.008, .008]))
    material = {"model": "mechanics.isotropic-elastic@1", "E": E, "nu": nu, "density": rho, "C": isotropic_elasticity(E, nu)}
    elements = [Element("beam2", np.array([i, i + 1]), material, {"stiffness": C, "mass": inertia, "frame": np.eye(3)}) for i in range(segments)]
    model = StructuralModel(np.arange(len(points)), points, elements, np.arange(len(points) * 6), np.arange(6), np.zeros((len(points), 6)))
    model.force[-1, 2] = force
    return model


def spring_model(mass=2., stiffness=50., damping=0., force=0.):
    model = StructuralModel(np.array([0]), np.zeros((1, 3)), [], np.array([0]), np.empty(0, dtype=int), np.array([[force, 0., 0., 0., 0., 0.]]))
    model.masses.append((0, mass, np.zeros((3, 3))))
    model.springs.append((0, -1, 1., stiffness, damping))
    return model


def test_linear_solver_handles_invertible_zero_diagonal_and_rejects_mechanism():
    matrix = sparse.csr_matrix([[0., 2.], [2., 0.]])
    np.testing.assert_allclose(solve_linear(matrix, np.array([4., 6.])), [3., 2.])
    with pytest.raises(ValueError, match="singular"):
        solve_linear(sparse.csr_matrix([[1., -1.], [-1., 1.]]), np.array([1., 0.]))


def test_static_truss_displacement_and_support_reaction():
    E, A, L, F = 2000., .03, 2., 7.
    material = {"model": "mechanics.isotropic-elastic@1", "E": E, "density": 2.}
    points = np.array([[0., 0., 0.], [L, 0., 0.]])
    model = StructuralModel(np.array([0, 1]), points, [Element("truss2", np.array([0, 1]), material, {"area": A})], np.array([0, 1, 2, 6, 7, 8]), np.array([0, 1, 2, 7, 8]), np.zeros((2, 6)))
    model.force[1, 0] = F
    K, M, _, prepared = prepare_matrices(model)
    result = static_analysis(model, prepared, K, M)
    np.testing.assert_allclose(result.displacement[1, 0], F * L / (E * A))
    np.testing.assert_allclose(result.reaction[0, 0], -F)
    assert result.residual < 1e-12


def test_cantilever_beam_mesh_convergence_and_reaction_balance():
    errors = []
    exact = 2**3 / (3 * 2e7 * 1e-6) + 2 / (2e7 / 2.6 * .008)
    for segments in (4, 16):
        model = beam_model(segments)
        K, M, _, prepared = prepare_matrices(model)
        result = static_analysis(model, prepared, K, M)
        errors.append(abs(result.displacement[-1, 2] / exact - 1))
        np.testing.assert_allclose(result.reaction[0, 2], -1., atol=2e-10)
        np.testing.assert_allclose(result.reaction[0, 4], 2., atol=3e-10)
    assert errors[1] < errors[0] and errors[1] < .01


def test_beam_first_mode_mass_normalization_and_euler_buckling():
    model = beam_model(20, 0.)
    K, M, _, prepared = prepare_matrices(model)
    result = modal_analysis(model, K, M, 2)
    expected = 1.875104068711961**2 / (2 * np.pi) * np.sqrt(2e7 * 1e-6 / (1000 * .01 * 2**4))
    np.testing.assert_allclose(result["frequencies"], expected, rtol=.01)
    flat = result["modes"].reshape(2, -1)
    np.testing.assert_allclose(flat @ M @ flat.T, np.eye(2), atol=2e-12)
    model.force[-1, 0] = -1.
    static = static_analysis(model, prepared, K, M)
    buckling = buckling_analysis(model, K, static.displacement, prepared, 2)
    euler = np.pi**2 * 2e7 * 1e-6 / (4 * 2**2)
    np.testing.assert_allclose(buckling["factors"], euler, rtol=.01)


def test_tilted_shell_massless_drilling_is_condensed_without_fake_inertia():
    points = np.array([[0., 0., 0.], [2., 0., 0.], [2., 1., 0.], [0., 1., 0.]])
    section = isotropic_section(2e6, .25, .05, 1000.)
    frequencies = []
    for Q in (np.eye(3), rotation_exp(np.array([.8, -.4, .3]))):
        model = StructuralModel(np.arange(4), points @ Q.T, [Element("shell4", np.arange(4), {"model": "mechanics.isotropic-elastic@1"}, section)], np.arange(24), np.r_[np.arange(6), np.arange(18, 24)], np.zeros((4, 6)))
        K, M, _, _ = prepare_matrices(model)
        modes = modal_analysis(model, K, M, 3)
        flat = modes["modes"].reshape(3, -1)
        np.testing.assert_allclose(flat @ M @ flat.T, np.eye(3), atol=4e-12)
        frequencies.append(modes["frequencies"])
    np.testing.assert_allclose(*frequencies, rtol=1e-8)


def test_harmonic_response_matches_complex_sdof_transfer_function():
    model = spring_model(mass=2., stiffness=50., damping=3., force=1.)
    K, M, C, _ = prepare_matrices(model)
    frequencies = np.array([.1, .5, 1.2])
    result = harmonic_analysis(model, K, M, C, frequencies)
    omega = 2 * np.pi * frequencies
    expected = 1 / (50 - 2 * omega**2 + 3j * omega)
    np.testing.assert_allclose(result["response"][:, 0, 0], expected)
    assert np.all(result["response"][:, 0, 0].imag < 0)


def test_newmark_sdof_energy_and_split_restart():
    model = spring_model()
    K, M, C, prepared = prepare_matrices(model)
    current = initial_solution(model)
    current.displacement[0, 0] = .1
    current.acceleration[0, 0] = -2.5
    energies = []
    for index in range(80):
        current = transient_step(model, current, prepared, K, M, C, np.zeros(6), .01, 0., 1e-10, 10, False)
        energies.append(current.strain_energy + current.kinetic_energy)
        if index == 39:
            checkpoint = deepcopy(current)
    np.testing.assert_allclose(energies, .25, rtol=2e-12)
    restarted = checkpoint
    for _ in range(40):
        restarted = transient_step(model, restarted, prepared, K, M, C, np.zeros(6), .01, 0., 1e-10, 10, False)
    np.testing.assert_array_equal(restarted.displacement, current.displacement)
    np.testing.assert_array_equal(restarted.velocity, current.velocity)
    assert restarted.time == current.time


def test_damping_does_not_brake_a_rigidly_spinning_beam():
    model = beam_model(2, 0.)
    rotation = rotation_exp(np.array([.8, -.7, .4]))
    translations = model.points @ rotation.T - model.points
    orientations = np.tile(rotation, (len(model.points), 1, 1))
    velocity = np.empty((len(model.points), 6))
    velocity[:, :3] = np.cross([.6, -.3, .8], model.points + translations) + [.1, .2, -.3]
    velocity[:, 3:] = [.6, -.3, .8]
    u = np.column_stack((translations, np.zeros_like(translations)))
    for use_section_damping in (False, True):
        if use_section_damping:
            for element in model.elements:
                element.section["damping"] = .003 * element.section["stiffness"]
        _, _, reference_damping, prepared = prepare_matrices(model)
        current = reference_damping + strain_rate_damping(model, u, orientations, prepared, 0. if use_section_damping else .003, True)
        # 큰 회전 중이어도 상대 변형률 속도가 0이면 점성 소산과 감쇠력이 0이다.
        np.testing.assert_allclose(current @ velocity.ravel(), 0., atol=2e-12)
        assert abs(velocity.ravel() @ current @ velocity.ravel()) < 1e-11


def test_stiffness_damping_matches_underdamped_oscillator():
    model = spring_model(mass=2., stiffness=50.)
    K, M, C, prepared = prepare_matrices(model)
    solution = initial_solution(model)
    solution.displacement[0, 0] = .1
    solution.acceleration[0, 0] = -2.5
    for _ in range(1000):
        solution = transient_step(model, solution, prepared, K, M, C, np.zeros(6), .001, 0., 1e-10, 10, False, damping_stiffness=.04)
    damped_frequency = np.sqrt(25 - .5**2)
    expected = .1 * np.exp(-.5) * (np.cos(damped_frequency) + .5 / damped_frequency * np.sin(damped_frequency))
    np.testing.assert_allclose(solution.displacement[0, 0], expected, rtol=8e-5)


def test_nonlinear_beam_static_converges_with_force_and_moment_balance():
    model = beam_model(1, force=3.)
    K, M, _, prepared = prepare_matrices(model)
    result = static_analysis(model, prepared, K, M, geometric=True, tolerance=1e-8)
    assert result.displacement[-1, 2] > .2
    assert result.residual < 1e-8
    np.testing.assert_allclose(result.reaction[0, :3], [0., 0., -3.], atol=3e-7)
    tip = model.points[-1] + result.displacement[-1, :3]
    np.testing.assert_allclose(result.reaction[0, 3:] + np.cross(tip, model.force[-1, :3]), 0., atol=3e-6)


def test_small_sliding_contact_closes_gap_without_tensile_reaction():
    points = np.array([[.2, .2, .1], [0., 0., 0.], [1., 0., 0.], [0., 1., 0.]])
    model = StructuralModel(np.arange(4), points, [], np.array([2]), np.empty(0, dtype=int), np.zeros((4, 6)))
    model.springs = [(2, -1, 1., 10., 0.)]
    model.contacts = [{"slaves": np.array([0]), "faces": np.array([[1, 2, 3]]), "penalty": 1000.}]
    model.force[0, 2] = -2.
    K, M, _, prepared = prepare_matrices(model)
    result = static_analysis(model, prepared, K, M)
    expected = (-2 - 1000 * .1) / 1010
    np.testing.assert_allclose(result.displacement[0, 2], expected, atol=1e-12)
    gap = .1 + expected
    np.testing.assert_allclose(result.strain_energy, 10 * expected**2 / 2 + 1000 * gap**2 / 2)
    model.force[0, 2] = 1.
    opened = static_analysis(model, prepared, K, M)
    np.testing.assert_allclose(opened.displacement[0, 2], .1)
    np.testing.assert_allclose(opened.reaction[1:, :3], 0.)


def test_solid_j2_static_matches_uniform_uniaxial_hardening_solution():
    points = np.array([[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.], [0., 0., 1.], [1., 0., 1.], [1., 1., 1.], [0., 1., 1.]])
    material = {"model": "mechanics.j2-plasticity@1", "E": 1000., "nu": .3, "density": 1., "yieldStress": 2., "hardening": 50., "C": isotropic_elasticity(1000., .3)}
    active = (6 * np.arange(8)[:, None] + np.arange(3)).ravel()
    fixed = np.array([6 * i + axis for i, xyz in enumerate(points) for axis in range(3) if xyz[axis] == 0])
    model = StructuralModel(np.arange(8), points, [Element("hex8", np.arange(8), material)], active, fixed, np.zeros((8, 6)))
    model.force[points[:, 0] == 1, 0] = 3 / 4
    K, M, _, prepared = prepare_matrices(model)
    result = static_analysis(model, prepared, K, M, tolerance=1e-9)
    np.testing.assert_allclose(result.displacement[points[:, 0] == 1, 0], 3 / 1000 + (3 - 2) / 50, rtol=1e-9)
    np.testing.assert_allclose(result.element_history[0]["equivalentPlasticStrain"], .02, rtol=1e-9)
    np.testing.assert_allclose(result.stresses[0][:, 0], 3., rtol=1e-9)
    np.testing.assert_allclose(result.stresses[0][:, 1:], 0., atol=1e-8)
    np.testing.assert_allclose(result.strain_energy, 3**2 / (2 * 1000), rtol=1e-9)
    accepted = deepcopy(result.element_history)
    result = initialize_acceleration(model, result, prepared, K, M, sparse.csr_matrix(K.shape), model.force.ravel())
    for _ in range(5):
        result = transient_step(model, result, prepared, K, M, sparse.csr_matrix(K.shape), .9 * model.force.ravel(), .0001, 0., 1e-9, 12, False)
    assert np.max(result.stresses[0][:, 0]) < 3.
    np.testing.assert_allclose(result.element_history[0]["plasticStrain"], accepted[0]["plasticStrain"], atol=2e-14)
    np.testing.assert_allclose(result.element_history[0]["equivalentPlasticStrain"], accepted[0]["equivalentPlasticStrain"], atol=2e-14)


def test_initial_acceleration_solves_sdof_equilibrium_instead_of_assuming_zero():
    model = spring_model(force=6.)
    K, M, C, prepared = prepare_matrices(model)
    initial = initial_solution(model)
    result = initialize_acceleration(model, initial, prepared, K, M, C, model.force.ravel())
    np.testing.assert_allclose(result.acceleration[0, 0], 3.)
    np.testing.assert_array_equal(initial.acceleration, 0.)


def test_rotating_lump_inertia_euler_gyroscopic_term_and_tangents():
    model = StructuralModel(np.array([0]), np.zeros((1, 3)), [], np.array([3, 4, 5]), np.empty(0, dtype=int), np.zeros((1, 6)))
    body = np.diag([2., 3., 4.])
    model.masses = [(0, 1., body)]
    _K, M, _C, prepared = prepare_matrices(model)
    R = np.array([rotation_exp(np.array([.8, -.3, .4]))])
    v, a, u = np.zeros((1, 6)), np.zeros((1, 6)), np.zeros((1, 6))
    v[0, 3:], a[0, 3:] = [1., 2., -.5], [.2, -.3, .4]
    force, moving, Kq, Kv, energy = inertial_response(model, u, R, v, a, prepared, M, True, True)
    inertia = R[0] @ body @ R[0].T
    expected = inertia @ a[0, 3:] + np.cross(v[0, 3:], inertia @ v[0, 3:])
    np.testing.assert_allclose(force[3:], expected)
    np.testing.assert_allclose(moving.toarray()[3:, 3:], inertia)
    np.testing.assert_allclose(energy, .5 * v[0, 3:] @ inertia @ v[0, 3:])
    direction, step = np.array([.2, -.4, .1]), 1e-6
    Rp, Rm = np.array([rotation_exp(step * direction) @ R[0]]), np.array([rotation_exp(-step * direction) @ R[0]])
    difference = (inertial_response(model, u, Rp, v, a, prepared, M, True)[0] - inertial_response(model, u, Rm, v, a, prepared, M, True)[0]) / (2 * step)
    np.testing.assert_allclose(Kq @ np.r_[np.zeros(3), direction], difference, atol=1e-8)
    vp, vm = v.copy(), v.copy(); vp[0, 3:] += step * direction; vm[0, 3:] -= step * direction
    difference = (inertial_response(model, u, R, vp, a, prepared, M, True)[0] - inertial_response(model, u, R, vm, a, prepared, M, True)[0]) / (2 * step)
    np.testing.assert_allclose(Kv @ np.r_[np.zeros(3), direction], difference, atol=1e-8)


def test_consistent_beam_rotation_has_whole_body_gyroscopic_moment():
    model = beam_model(1, 0.)
    model.points -= model.points.mean(axis=0)
    _K, M, _C, prepared = prepare_matrices(model)
    u, v, a = np.zeros((2, 6)), np.zeros((2, 6)), np.zeros((2, 6))
    R = np.tile(np.eye(3), (2, 1, 1))
    omega = np.array([1., 2., 3.])
    v[:, :3], v[:, 3:] = np.cross(omega, model.points), omega
    a[:, :3] = np.cross(omega, v[:, :3])
    force, _, _, _, energy = inertial_response(model, u, R, v, a, prepared, M, True)
    nodal = force.reshape(2, 6)
    torque = np.sum(np.cross(model.points, nodal[:, :3]) + nodal[:, 3:], axis=0)
    length = 2.
    inertia = 1000 * .01 * length * np.diag([0., length**2 / 12, length**2 / 12]) + length * model.elements[0].section["mass"][3:, 3:]
    np.testing.assert_allclose(torque, np.cross(omega, inertia @ omega), atol=2e-8)
    np.testing.assert_allclose(nodal[:, :3].sum(axis=0), 0., atol=2e-8)
    np.testing.assert_allclose(energy, .5 * omega @ inertia @ omega)


def test_rigid_link_rate_jacobians_include_centripetal_and_pitch_motion():
    model = StructuralModel(np.arange(2), np.array([[0., 0., 0.], [.5, 1., .2]]), [], np.arange(12), np.empty(0, dtype=int), np.zeros((2, 6)))
    model.links = [(0, 1, np.arange(6))]
    model.rotor = {"bladeRootNodes": np.array([1])}
    R = np.tile(rotation_exp(np.array([.3, -.2, .1])), (2, 1, 1))
    u, v, a = np.zeros((2, 6)), np.zeros((2, 6)), np.zeros((2, 6))
    v[0], a[0] = [.1, .2, -.1, 1., 2., 3.], [.3, .2, .1, .2, -.4, .3]
    enforce_links(model, u, R, .1)
    T = constraint_transform(model, R)
    _, _, V, A = kinematic_rates(model, R, v, a, .3, .2, T, 7., 13.)
    direction = np.array([.2, -.1, .3, -.3, .1, .2])
    full = np.asarray(T @ direction).reshape(2, 6)
    step = 1e-6
    _up, Rp = apply_increment(model, u, R, full.ravel() * step, .1)
    _um, Rm = apply_increment(model, u, R, -full.ravel() * step, .1)
    vp, ap, _, _ = kinematic_rates(model, Rp, v + 7 * step * full, a + 13 * step * full, .3, .2)
    vm, am, _, _ = kinematic_rates(model, Rm, v - 7 * step * full, a - 13 * step * full, .3, .2)
    np.testing.assert_allclose(V @ direction, ((vp - vm) / (2 * step)).ravel(), rtol=3e-8, atol=1e-8)
    np.testing.assert_allclose(A @ direction, ((ap - am) / (2 * step)).ravel(), rtol=3e-8, atol=1e-8)


def test_fixed_axis_rigid_rotor_preserves_continuous_spin_and_energy():
    radius, omega = 2., 3.
    points = np.array([[0., 0., 0.], [0., radius, 0.], [0., -radius, 0.]])
    model = StructuralModel(np.arange(3), points, [], np.arange(18), np.array([0, 1, 2, 4, 5]), np.zeros((3, 6)))
    model.links = [(0, 1, np.arange(6)), (0, 2, np.arange(6))]
    model.masses = [(0, 1., np.eye(3) * .1), (1, 2., np.zeros((3, 3))), (2, 2., np.zeros((3, 3)))]
    K, M, C, prepared = prepare_matrices(model)
    current = initial_solution(model)
    current.velocity[0, 3] = omega
    current = initialize_acceleration(model, current, prepared, K, M, C, np.zeros(18), geometric=True)
    np.testing.assert_allclose(current.acceleration[1:, :3], -omega**2 * points[1:], atol=1e-12)
    initial_energy = current.kinetic_energy
    for _ in range(50):
        current = transient_step(model, current, prepared, K, M, C, np.zeros(18), .02, 0., 1e-9, 12, True)
    exact = points @ rotation_exp(np.array([omega, 0., 0.])).T
    np.testing.assert_allclose(points + current.displacement[:, :3], exact, atol=1e-12)
    np.testing.assert_allclose(current.velocity[:, 3], omega, atol=1e-12)
    np.testing.assert_allclose(current.kinetic_energy, initial_energy, rtol=1e-13)


def test_free_asymmetric_rotor_euler_acceleration_and_conservation_refine_with_dt():
    model = StructuralModel(np.array([0]), np.zeros((1, 3)), [], np.array([3, 4, 5]), np.empty(0, dtype=int), np.zeros((1, 6)))
    body = np.diag([2., 3., 4.]); model.masses = [(0, 1., body)]
    K, M, C, prepared = prepare_matrices(model)
    initial = initial_solution(model); initial.velocity[0, 3:] = [1., .7, .2]
    initial = initialize_acceleration(model, initial, prepared, K, M, C, np.zeros(6), geometric=True)
    omega = initial.velocity[0, 3:]
    np.testing.assert_allclose(initial.acceleration[0, 3:], -np.linalg.solve(body, np.cross(omega, body @ omega)))
    errors = []
    for dt in (.02, .01):
        current = deepcopy(initial)
        for _ in range(round(.4 / dt)):
            current = transient_step(model, current, prepared, K, M, C, np.zeros(6), dt, 0., 1e-10, 15, True)
        momentum = current.orientations[0] @ body @ current.orientations[0].T @ current.velocity[0, 3:]
        errors.append(abs(current.kinetic_energy / initial.kinetic_energy - 1) + np.linalg.norm(momentum - body @ omega) / np.linalg.norm(body @ omega))
    assert errors[1] < errors[0] * .4 and errors[1] < 1e-4


def test_eccentric_rigid_link_static_includes_constraint_geometric_stiffness():
    model = StructuralModel(np.arange(2), np.array([[0., 0., 0.], [1., 0., 0.]]), [], np.arange(12), np.array([0, 1, 2, 3, 4]), np.zeros((2, 6)))
    model.links = [(0, 1, np.arange(6))]
    model.springs = [(5, -1, 1., 10., 0.)]
    model.force[1, 1] = 2.
    K, M, _C, prepared = prepare_matrices(model)
    result = static_analysis(model, prepared, K, M, geometric=True)
    angle = result.displacement[0, 5]
    np.testing.assert_allclose(10 * angle, 2 * np.cos(angle), rtol=1e-8)


def test_free_free_beam_modal_analysis_skips_six_rigid_body_modes():
    model = beam_model(20, 0.)
    model.fixed = np.empty(0, dtype=int)
    K, M, _, _ = prepare_matrices(model)
    result = modal_analysis(model, K, M, 2)
    exact = 4.730040744862704**2 / (2 * np.pi * 2**2) * np.sqrt(2e7 * 1e-6 / (1000 * .01))
    np.testing.assert_allclose(result["frequencies"], exact, rtol=.01)
    modes = result["modes"].reshape(2, -1)
    np.testing.assert_allclose(modes @ M @ modes.T, np.eye(2), atol=1e-9)
