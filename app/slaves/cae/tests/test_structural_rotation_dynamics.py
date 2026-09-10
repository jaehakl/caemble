"""다축 회전과 탄성 변형이 동시에 있는 보의 에너지·운동량·시간 수렴."""

from copy import deepcopy
from itertools import pairwise

import numpy as np
import pytest

from app.solvers.structural_mechanics.analysis import (
    initial_solution,
    initialize_acceleration,
    transient_step,
)
from app.solvers.structural_mechanics.beam import isotropic_beam_section
from app.solvers.structural_mechanics.formulation import (
    inertial_response,
    prepare_matrices,
    strain_rate_damping,
    structural_response,
)
from app.solvers.structural_mechanics.model import Element, StructuralModel
from app.solvers.structural_mechanics.rotations import rotation_exp


def loaded_rotating_beam(damped):
    points = np.array([[-1., 0., 0.], [0., 0., 0.], [1., 0., 0.]])
    stiffness, inertia = isotropic_beam_section(200., .25, 2., .2, np.array([.05, .02, .03]), np.array([.15, .15]))
    section = {"stiffness": stiffness, "mass": inertia, "frame": np.eye(3)}
    if damped:
        section["damping"] = .003 * stiffness
    elements = [Element("beam2", np.array([i, i + 1]), {"model": "mechanics.isotropic-elastic@1"}, section) for i in range(2)]
    model = StructuralModel(np.arange(3), points, elements, np.arange(18), np.empty(0, dtype=int), np.zeros((3, 6)))
    solution = initial_solution(model)
    local_positions = points.copy(); local_positions[1, 1:] = [.03, -.02]
    rotation = rotation_exp([1.1, -.7, .4])
    solution.displacement[:, :3] = local_positions @ rotation.T - points
    solution.orientations[:] = rotation
    solution.orientations[1] = rotation @ rotation_exp([.04, -.03, .02])
    omega = rotation @ [.8, .5, .3]
    solution.velocity[:, :3] = np.cross(omega, local_positions @ rotation.T)
    solution.velocity[:, 3:] = omega
    force = np.zeros((3, 6))
    force[2, :3] = rotation @ [.03, .06, -.04]
    force[0, :3] = -force[2, :3]
    force[2, 3:] = rotation @ [.01, -.02, .03]
    matrices = prepare_matrices(model)
    K, M, C, prepared = matrices
    beta = .004 if damped else 0.
    solution = initialize_acceleration(model, solution, prepared, K, M, C, force.ravel(), True, damping_stiffness=beta)
    return model, solution, matrices, force, beta


def mechanical_totals(model, solution, matrices, beta):
    _K, M, C, prepared = matrices
    moving = inertial_response(model, solution.displacement, solution.orientations, solution.velocity, solution.acceleration, prepared, M, True)[1]
    momentum = (moving @ solution.velocity.ravel()).reshape(-1, 6)
    angular_momentum = np.sum(np.cross(model.points + solution.displacement[:, :3], momentum[:, :3]) + momentum[:, 3:], axis=0)
    damping = C + strain_rate_damping(model, solution.displacement, solution.orientations, prepared, beta, True)
    dissipation = solution.velocity.ravel() @ damping @ solution.velocity.ravel()
    return solution.strain_energy + solution.kinetic_energy, angular_momentum, dissipation


def test_batched_beams_match_scalar_force_tangent_mass_gyro_and_damping():
    model, initial, (_K, M, _C, prepared), _, beta = loaded_rotating_beam(True)
    scalar = [dict(data) for data in prepared]
    scalar[0].pop("beamBatch")
    rng = np.random.default_rng(23)
    velocity = initial.velocity + .1 * rng.normal(size=initial.velocity.shape)
    acceleration = .2 * rng.normal(size=initial.acceleration.shape)
    batch_force = structural_response(model, initial.displacement, initial.orientations, prepared, None, True, True)
    scalar_force = structural_response(model, initial.displacement, initial.orientations, scalar, None, True, True)
    np.testing.assert_allclose(batch_force[0], scalar_force[0], rtol=1e-10, atol=1e-11)
    np.testing.assert_allclose(batch_force[1].toarray(), scalar_force[1].toarray(), rtol=1e-10, atol=1e-11)
    np.testing.assert_allclose(batch_force[4], scalar_force[4], rtol=1e-11)
    batch_inertia = inertial_response(model, initial.displacement, initial.orientations, velocity, acceleration, prepared, M, True, True)
    scalar_inertia = inertial_response(model, initial.displacement, initial.orientations, velocity, acceleration, scalar, M, True, True)
    for left, right in zip(batch_inertia, scalar_inertia):
        if hasattr(left, "toarray"):
            left, right = left.toarray(), right.toarray()
        np.testing.assert_allclose(left, right, rtol=1e-10, atol=1e-11)
    batch_damping = strain_rate_damping(model, initial.displacement, initial.orientations, prepared, beta, True)
    scalar_damping = strain_rate_damping(model, initial.displacement, initial.orientations, scalar, beta, True)
    np.testing.assert_allclose(batch_damping.toarray(), scalar_damping.toarray(), rtol=1e-10, atol=1e-11)


@pytest.mark.parametrize("damped", [False, True])
def test_loaded_multiaxis_beam_time_refinement_and_energy_work_balance(damped):
    model, initial, matrices, force, beta = loaded_rotating_beam(damped)
    K, M, C, prepared = matrices
    initial_energy, initial_momentum, initial_dissipation = mechanical_totals(model, initial, matrices, beta)
    results, defects = [], []
    for dt in (.01, .005, .0025):
        current = deepcopy(initial)
        work, dissipated = 0., 0.
        angular_impulse = np.zeros(3)
        previous_dissipation = initial_dissipation
        for _ in range(round(.2 / dt)):
            previous = current
            current = transient_step(model, current, prepared, K, M, C, force.ravel(), dt, 0., 1e-10, 20, True, damping_stiffness=beta)
            energy, momentum, dissipation = mechanical_totals(model, current, matrices, beta)
            # 외력의 일은 힘·속도 적분, 각충격량은 위치×힘+모멘트 적분입니다.
            # 내부 힘이나 Newton 잔차를 참값으로 사용하지 않습니다.
            work += dt / 2 * np.sum(force * (previous.velocity + current.velocity))
            arms_sum = 2 * model.points + previous.displacement[:, :3] + current.displacement[:, :3]
            angular_impulse += dt / 2 * np.sum(np.cross(arms_sum, force[:, :3]) + 2 * force[:, 3:], axis=0)
            dissipated += dt / 2 * (previous_dissipation + dissipation)
            previous_dissipation = dissipation
            assert dissipation >= -1e-12
        defects.append([abs(energy - initial_energy - work + dissipated) / initial_energy, np.linalg.norm(momentum - initial_momentum - angular_impulse) / np.linalg.norm(initial_momentum)])
        results.append(current)
        if damped:
            assert dissipated > 1e-4
    differences = [np.linalg.norm(a.displacement[:, :3] - b.displacement[:, :3]) + np.linalg.norm(a.orientations - b.orientations) for a, b in pairwise(results)]
    assert differences[1] < .4 * differences[0]
    assert max(defects[-1]) < 2e-4
    assert defects[-1][0] < .4 * defects[-2][0]
    assert defects[-1][1] < .35 * defects[-2][1]
    # 실제 각속도 방향이 달라져 단순한 일정 축 강체 회전 시험이 아님을 확인합니다.
    assert np.linalg.norm(np.cross(initial.velocity[1, 3:], results[-1].velocity[1, 3:])) > .01
