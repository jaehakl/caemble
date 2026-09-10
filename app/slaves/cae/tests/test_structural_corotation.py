"""큰 강체 회전, 에너지 가상일, 내부 모멘트 평형과 실제 접선 검증."""

import numpy as np

from app.solvers.structural_mechanics.beam import (
    beam_deformation,
    beam_force,
    beam_kinematics,
    beam_matrices,
    beam_response,
    isotropic_beam_section,
)
from app.solvers.structural_mechanics.corotation import (
    shell_corotational_response,
    shell_deformation,
    variational_force,
)
from app.solvers.structural_mechanics.rotations import rotation_exp, rotation_log
from app.solvers.structural_mechanics.shells import isotropic_section, shell4_matrices


def test_rotation_exponential_logarithm_small_and_near_pi():
    axis = np.array([1., -2., 3.]); axis /= np.linalg.norm(axis)
    for angle in (1e-10, .7, np.pi - 1e-8, np.pi):
        R = rotation_exp(axis * angle)
        np.testing.assert_allclose(rotation_exp(rotation_log(R)), R, atol=3e-8)
        np.testing.assert_allclose(R.T @ R, np.eye(3), atol=2e-15)


def test_beam_kinematics_cache_cannot_be_poisoned_by_input_or_output_mutation():
    points = np.array([[0., 0., 0.], [2., 0., 0.]])
    displacement = np.zeros((2, 3))
    rotations = np.tile(np.eye(3), (2, 1, 1))
    original = beam_kinematics(points, displacement, rotations, np.eye(3))
    with np.testing.assert_raises(ValueError):
        original[0][6] = 99.
    displacement[1, 0] = .1
    changed = beam_kinematics(points, displacement, rotations, np.eye(3))
    np.testing.assert_allclose(original[0][6], 0.)
    np.testing.assert_allclose(changed[0][6], .1)


def test_corotational_beam_force_is_energy_gradient_and_balances_internal_moment():
    points = np.array([[0., 0., 0.], [2., 0., 0.]])
    translations = np.array([[0., 0., 0.], [.2, .3, .1]])
    rotations = np.array([rotation_exp(np.array([.1, .2, .3])), rotation_exp(np.array([-.2, .1, -.1]))])
    section, inertia = isotropic_beam_section(2e5, .3, 1., .02, np.array([.001, .0005, .0005]), np.array([.015, .015]))
    K, _ = beam_matrices(2., section, inertia)
    force, _, energy = beam_force(points, translations, rotations, np.eye(3), K)
    numerical = np.empty(12)
    for column in range(12):
        node, component = divmod(column, 6)
        h = 8e-7
        up, um = translations.copy(), translations.copy()
        rp, rm = rotations.copy(), rotations.copy()
        if component < 3:
            up[node, component] += h; um[node, component] -= h
        else:
            delta = np.eye(3)[component - 3] * h
            rp[node] = rotation_exp(delta) @ rp[node]
            rm[node] = rotation_exp(-delta) @ rm[node]
        dp = beam_deformation(points, up, rp, np.eye(3))[0]
        dm = beam_deformation(points, um, rm, np.eye(3))[0]
        numerical[column] = (dp @ K @ dp - dm @ K @ dm) / (4 * h)
    np.testing.assert_allclose(force, numerical, rtol=3e-8, atol=2e-7)
    nodal = force.reshape(2, 6)
    np.testing.assert_allclose(nodal[:, :3].sum(axis=0), 0., atol=2e-7)
    np.testing.assert_allclose((nodal[:, 3:] + np.cross(points + translations, nodal[:, :3])).sum(axis=0), 0., atol=3e-7)
    assert energy > 0


def test_beam_rigid_rotation_objectivity_and_spatial_tangent():
    points = np.array([[0., 0., 0.], [2., 0., 0.]])
    translations = np.array([[0., 0., 0.], [.1, .1, -.05]])
    rotations = np.array([rotation_exp(np.array([.05, .03, .02])), rotation_exp(np.array([-.02, .06, -.03]))])
    section, inertia = isotropic_beam_section(2e5, .3, 1., .02, np.array([.001, .0005, .0005]), np.array([.015, .015]))
    K, _ = beam_matrices(2., section, inertia)
    force, tangent, energy = beam_response(points, translations, rotations, np.eye(3), K)
    Q = rotation_exp(np.array([1.2, -.4, .9]))
    moved = (points + translations) @ Q.T + [3., -1., 2.] - points
    moved_rotations = np.array([Q @ R for R in rotations])
    rotated_force, _, rotated_energy = beam_force(points, moved, moved_rotations, np.eye(3), K)
    np.testing.assert_allclose(rotated_energy, energy, rtol=2e-14)
    np.testing.assert_allclose(rotated_force.reshape(-1, 3), force.reshape(-1, 3) @ Q.T, rtol=3e-8, atol=3e-7)
    rigid_u = points @ Q.T + [3., -1., 2.] - points
    rigid_force, _, rigid_energy = beam_force(points, rigid_u, np.array([Q, Q]), np.eye(3), K)
    np.testing.assert_allclose(rigid_force, 0., atol=1e-10)
    assert rigid_energy < 1e-25
    direction = np.random.default_rng(2).normal(size=(2, 6))
    h = 3e-5
    up, um = translations + h * direction[:, :3], translations - h * direction[:, :3]
    rp = np.array([rotation_exp(h * d[3:]) @ R for d, R in zip(direction, rotations)])
    rm = np.array([rotation_exp(-h * d[3:]) @ R for d, R in zip(direction, rotations)])
    difference = (beam_force(points, up, rp, np.eye(3), K)[0] - beam_force(points, um, rm, np.eye(3), K)[0]) / (2 * h)
    np.testing.assert_allclose(tangent @ direction.ravel(), difference, rtol=2e-5, atol=.003)


def test_shell_corotation_rigid_motion_objectivity_and_energy_gradient():
    points = np.array([[0., 0., 0.], [2., 0., 0.], [2., 3., 0.], [0., 3., 0.]])
    section = isotropic_section(1300., .25, .2, 2.)
    K, _ = shell4_matrices(points, section)
    length = np.max(np.linalg.norm(points - points.mean(axis=0), axis=1))
    translations = np.array([[.01, -.01, .03], [.02, 0., -.01], [.03, .01, .07], [-.01, -.02, -.01]])
    rotations = np.array([rotation_exp(v) for v in [[.02, .01, 0.], [.01, -.02, .01], [.04, .01, -.02], [-.01, .03, .01]]])
    deformation = lambda u, R: shell_deformation(points, u, R)
    force, energy, _ = variational_force(deformation, translations, rotations, K, length)
    nodal = force.reshape(4, 6)
    np.testing.assert_allclose(nodal[:, :3].sum(axis=0), 0., atol=2e-8)
    np.testing.assert_allclose((nodal[:, 3:] + np.cross(points + translations, nodal[:, :3])).sum(axis=0), 0., atol=5e-8)
    direction = np.random.default_rng(3).normal(size=(4, 6))
    h = 1e-6
    up, um = translations + h * direction[:, :3], translations - h * direction[:, :3]
    rp = np.array([rotation_exp(h * d[3:]) @ R for d, R in zip(direction, rotations)])
    rm = np.array([rotation_exp(-h * d[3:]) @ R for d, R in zip(direction, rotations)])
    dp, dm = deformation(up, rp), deformation(um, rm)
    np.testing.assert_allclose(force @ direction.ravel(), (dp @ K @ dp - dm @ K @ dm) / (4 * h), rtol=2e-8)
    Q = rotation_exp(np.array([1.6, -.7, .3]))
    moved = (points + translations) @ Q.T + [4., 2., -3.] - points
    moved_R = np.array([Q @ R for R in rotations])
    moved_force, moved_energy, _ = variational_force(deformation, moved, moved_R, K, length)
    np.testing.assert_allclose(moved_energy, energy, rtol=1e-13)
    np.testing.assert_allclose(moved_force.reshape(-1, 3), force.reshape(-1, 3) @ Q.T, rtol=3e-7, atol=5e-8)
    rigid_u = points @ Q.T + [4., 2., -3.] - points
    rigid_force, rigid_energy, local = variational_force(deformation, rigid_u, np.broadcast_to(Q, (4, 3, 3)), K, length)
    np.testing.assert_allclose(local, 0., atol=2e-15)
    np.testing.assert_allclose(rigid_force, 0., atol=1e-11)
    assert rigid_energy < 1e-25


def test_shell_corotational_tangent_matches_spatial_increment_and_reports_warping():
    points = np.array([[0., 0., 0.], [2., 0., 0.], [2., 3., 0.], [0., 3., 0.]])
    section = isotropic_section(1300., .25, .2, 2.)
    translations = np.zeros((4, 3)); translations[2] = [.02, .01, .04]
    rotations = np.array([rotation_exp(v) for v in [[.01, 0., 0.], [0., -.01, 0.], [.02, -.02, .01], [0., .01, 0.]]])
    _force, tangent, energy, response = shell_corotational_response(points, translations, rotations, section)
    assert energy > 0 and np.linalg.norm(response["curvature"]) > 0
    K, _ = shell4_matrices(points, section)
    length = np.max(np.linalg.norm(points - points.mean(axis=0), axis=1))
    deformation = lambda u, R: shell_deformation(points, u, R)
    direction = np.random.default_rng(7).normal(size=(4, 6))
    h = 3e-5
    up, um = translations + h * direction[:, :3], translations - h * direction[:, :3]
    rp = np.array([rotation_exp(h * d[3:]) @ R for d, R in zip(direction, rotations)])
    rm = np.array([rotation_exp(-h * d[3:]) @ R for d, R in zip(direction, rotations)])
    plus = variational_force(deformation, up, rp, K, length)[0]
    minus = variational_force(deformation, um, rm, K, length)[0]
    np.testing.assert_allclose(tangent @ direction.ravel(), (plus - minus) / (2 * h), rtol=3e-5, atol=.002)
