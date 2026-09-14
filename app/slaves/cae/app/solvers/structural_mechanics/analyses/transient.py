"""Initial acceleration and one converged Newmark time step."""

from copy import deepcopy

import numpy as np
from scipy import linalg, sparse

from ..constraints import (
    constraint_transform,
    contact_response,
    enforce_links,
    revolute_joints,
    spring_gradient,
    spring_gradient_tangent,
    support_reactions,
)
from ..kinematics import _link_geometric_matrix, _rotation_coordinate_jacobians, kinematic_rates
from ..model import StructuralSolution
from ..numerics import _positive_sparse_mass, solve_linear
from ..operators.damping import strain_rate_damping
from ..operators.inertia import inertial_response
from ..operators.internal import structural_response
from ..rotations import rotation_exp_many, rotation_log_many


def initialize_acceleration(model, solution, prepared, stiffness, mass, damping, external, geometric=False, pitch=0., pitch_rate=0., pitch_acceleration=0., damping_stiffness=0.):
    """초기 위치·속도에서 실제 평형식으로 가속도를 구합니다.

    external은 기존 호출과 같이 기준 질량으로 계산한 중력 항을 포함합니다.
    유한회전에서는 그 항을 현재 질량 방향으로 교체합니다. 회전 로터의
    구심가속도는 종속 절점에 먼저 넣고, 남은 독립 가속도를 푼 뒤 더합니다.
    """
    result = deepcopy(solution)
    enforce_links(model, result.displacement, result.orientations, pitch)
    damping = damping + strain_rate_damping(model, result.displacement, result.orientations, prepared, damping_stiffness, geometric)
    T = constraint_transform(model, result.orientations)
    velocity, convective, _, _ = kinematic_rates(model, result.orientations, result.velocity, np.zeros_like(result.acceleration), pitch_rate, pitch_acceleration, T)
    gravity = np.zeros(model.size)
    gravity.reshape(-1, 6)[:, :3] = model.gravity
    # 초기 가속도에는 내력만 필요하다. 사용하지 않는 보의 완전 Hessian을
    # 만들지 않아도 내력·응력·에너지·재료 이력은 정확히 같은 식이다.
    internal, _, history, stresses, energy = structural_response(model, result.displacement, result.orientations, prepared, result.element_history, geometric, approximate_tangent=True)
    inertia, moving_mass, _, _, kinetic = inertial_response(model, result.displacement, result.orientations, velocity, convective - gravity.reshape(-1, 6), prepared, mass, geometric)
    rhs = np.asarray(T.T @ (external - mass @ gravity - internal - damping @ velocity.ravel() - inertia))
    reduced_mass = (T.T @ moving_mass @ T).tocsr()
    if len(rhs):
        if len(rhs) > 128 and _positive_sparse_mass(reduced_mass):
            independent = solve_linear(reduced_mass, rhs)
        else:
            dense_mass = reduced_mass.toarray()
            diagonal = np.abs(np.diag(dense_mass))
            scaling = np.ones(len(rhs))
            scaling[diagonal > 0] = 1 / np.sqrt(diagonal[diagonal > 0])
            values, vectors = linalg.eigh(dense_mass * np.outer(scaling, scaling))
            tolerance = max(np.max(np.abs(values)), 1.) * 1e-12
            positive = values > tolerance
            projected = vectors.T @ (scaling * rhs)
            if np.linalg.norm(projected[~positive]) > 1e-8 * max(np.linalg.norm(projected), 1.):
                raise ValueError("massless coordinates must be in equilibrium before initializing acceleration")
            independent = scaling * (vectors[:, positive] @ (projected[positive] / values[positive]))
        acceleration = np.asarray(T @ independent).reshape(-1, 6) + convective
    else:
        acceleration = convective
    result.velocity, result.acceleration = velocity, acceleration
    result.element_history, result.stresses = history, stresses
    result.strain_energy, result.kinetic_energy = energy, kinetic
    result.contact_history = contact_response(model.points, result.displacement, model.contacts)[2] if model.contacts else []
    inertia = inertial_response(model, result.displacement, result.orientations, velocity, acceleration - gravity.reshape(-1, 6), prepared, mass, geometric)[0]
    result.reaction = support_reactions(model, result.orientations, internal + inertia + damping @ velocity.ravel() - external + mass @ gravity)
    return result


def transient_step(model, solution, prepared, stiffness, mass, damping, external, dt, pitch, tolerance, max_iterations, geometric, cancellation=None, *, pitch_rate=0., pitch_acceleration=0., damping_stiffness=0., joint_torques=None, initial_guess=None):
    """같은 물리적 시작 상태에서 Newmark 평형을 푼다.

    initial_guess는 (병진 변위, 공간 회전행렬) 두 배열뿐이다. 이전 trial의
    속도·가속도·재료 이력은 가져오지 않는다. 추정이 나쁘면 원래 predictor로
    다시 풀며, 두 경로에 동일한 평형 허용오차와 최대 반복 수를 적용한다.
    """
    options = {"pitch_rate": pitch_rate, "pitch_acceleration": pitch_acceleration, "damping_stiffness": damping_stiffness, "joint_torques": joint_torques}
    if initial_guess is not None:
        try:
            return _newmark_step(model, solution, prepared, stiffness, mass, damping, external, dt, pitch, tolerance, max_iterations, geometric, cancellation, initial_guess=initial_guess, **options)
        except (ValueError, np.linalg.LinAlgError):
            # 추정의 실패는 checkpoint를 수정하지 않는다. 원래 입력도 잘못된
            # 경우에는 아래 기본 경로의 구체적인 오류를 호출자에게 전달한다.
            pass
    return _newmark_step(model, solution, prepared, stiffness, mass, damping, external, dt, pitch, tolerance, max_iterations, geometric, cancellation, **options)


def _newmark_step(model, solution, prepared, stiffness, mass, damping, external, dt, pitch, tolerance, max_iterations, geometric, cancellation=None, *, pitch_rate=0., pitch_acceleration=0., damping_stiffness=0., joint_torques=None, initial_guess=None):
    """Newmark beta=1/4, gamma=1/2. 회전은 고정 predictor에 대해 구성한다.

    이 함수는 한 내부 시간 단계만 담당한다. 실패하면 호출자가 같은
    시작 상태에서 dt를 줄여 재시도한다. 외부 연성 구간의 끝은 바꾸지 않는다.
    """
    # 조인트의 자유 회전 slot은 unwrapped 상대각 q입니다. 공개 속도/가속도는
    # 공간 벡터이므로 qdot=axis·(omega_slave-omega_master)로 먼저 바꿉니다.
    coordinate_velocity, coordinate_acceleration = solution.velocity.copy(), solution.acceleration.copy()
    joints = revolute_joints(model)
    for slave, (master, axis_index) in joints.items():
        axis = solution.orientations[master][:, axis_index]
        coordinate_velocity[slave, 3 + axis_index] = axis @ (solution.velocity[slave, 3:] - solution.velocity[master, 3:])
        coordinate_acceleration[slave, 3 + axis_index] = axis @ (solution.acceleration[slave, 3:] - solution.acceleration[master, 3:])
    predictor = solution.displacement + dt * coordinate_velocity + dt**2 / 4 * coordinate_acceleration
    velocity_predictor = coordinate_velocity + dt / 2 * coordinate_acceleration
    displacement = predictor.copy()
    rotation_predictor = rotation_exp_many(dt * solution.velocity[:, 3:] + dt**2 / 4 * solution.acceleration[:, 3:]) @ solution.orientations
    rotations = rotation_predictor.copy()
    enforce_links(model, displacement, rotations, pitch)
    if initial_guess is not None:
        guess_translations, guess_rotations = (np.asarray(value, dtype=float) for value in initial_guess)
        if guess_translations.shape != (len(model.points), 3) or guess_rotations.shape != rotations.shape or not np.all(np.isfinite(guess_translations)) or not np.all(np.isfinite(guess_rotations)):
            raise ValueError("Newmark initial guess has invalid shapes or nonfinite values")
        if not np.allclose(guess_rotations @ guess_rotations.transpose(0, 2, 1), np.eye(3), atol=1e-10) or np.any(np.linalg.det(guess_rotations) <= 0):
            raise ValueError("Newmark initial guess orientations must be proper rotation matrices")
        displacement[:, :3] = guess_translations
        displacement[:, 3:] = predictor[:, 3:] + rotation_log_many(guess_rotations @ rotation_predictor.transpose(0, 2, 1))
        for slave, (master, axis_index) in joints.items():
            # q 자체는 여러 바퀴를 돌아도 연속이다. log(R)를 q로 대체하지 않고,
            # 이번 dt의 predictor 상대각에 작은 master-relative 차이만 더한다.
            guess_relative = guess_rotations[master].T @ guess_rotations[slave]
            predicted_relative = rotations[master].T @ rotations[slave]
            difference = rotation_log_many((guess_relative @ predicted_relative.T)[None])[0]
            displacement[slave, 3 + axis_index] = predictor[slave, 3 + axis_index] + difference[axis_index]
        displacement.ravel()[model.fixed] = 0.
        rotations = rotation_exp_many(displacement[:, 3:] - predictor[:, 3:]) @ rotation_predictor
        enforce_links(model, displacement, rotations, pitch)
    gravity = np.zeros(model.size)
    gravity.reshape(-1, 6)[:, :3] = model.gravity
    applied = external - mass @ gravity
    previous_relative = float("inf")
    full_tangent = False
    for iteration in range(max_iterations):
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        acceleration = 4 / dt**2 * (displacement - predictor)
        velocity = velocity_predictor + dt / 2 * acceleration
        joint_rates = {slave: (velocity[slave, 3 + axis], acceleration[slave, 3 + axis]) for slave, (_, axis) in joints.items()}
        rotation_jacobians = _rotation_coordinate_jacobians(displacement[:, 3:] - predictor[:, 3:]) if geometric else None
        T = constraint_transform(model, rotations)
        velocity, acceleration, V, A = kinematic_rates(model, rotations, velocity, acceleration, pitch_rate, pitch_acceleration, T, 2 / dt, 4 / dt**2, joint_rates=joint_rates, rotation_jacobians=rotation_jacobians)
        internal, tangent, history, stress, energy = structural_response(model, displacement, rotations, prepared, solution.element_history, geometric, approximate_tangent=not full_tangent)
        current_damping = damping + strain_rate_damping(model, displacement, rotations, prepared, damping_stiffness, geometric)
        inertial, moving_mass, configuration_inertia, velocity_inertia, kinetic = inertial_response(model, displacement, rotations, velocity, acceleration - gravity.reshape(-1, 6), prepared, mass, geometric, derivatives=True, exact_tangent=full_tangent)
        follower_force = np.zeros(model.size)
        follower_tangent = sparse.csr_matrix((model.size, model.size))
        for slave, torque in (joint_torques or {}).items():
            coordinate = 6 * slave + 3 + joints[slave][1]
            follower_force += torque * spring_gradient(model, rotations, coordinate, -1, 0.)
            follower_tangent += torque * spring_gradient_tangent(model, rotations, coordinate, -1, 0.)
        residual_full = applied + follower_force - internal - inertial - current_damping @ velocity.ravel()
        residual = T.T @ residual_full
        scale = max(np.linalg.norm(T.T @ (external + follower_force)), np.linalg.norm(T.T @ inertial), 1.0)
        relative = np.linalg.norm(residual) / scale
        if relative <= tolerance:
            # 과거 이력 조각은 불변 배열이며 호출자가 새 조각을 추가합니다.
            # 매 단계 전체 배열을 복사하면 장시간 계산 비용이 제곱으로 늘어납니다.
            result = StructuralSolution(displacement, velocity, acceleration, rotations, support_reactions(model, rotations, -residual_full), dict(solution.history), history, stress, solution.time + dt, iteration + 1, float(relative), energy, kinetic)
            result.contact_history = contact_response(model.points, displacement, model.contacts)[2] if model.contacts else []
            return result
        if not full_tangent and iteration >= 2 and relative > .5 * previous_relative:
            # 반복법의 접선만 근사합니다. 실제 동역학 잔차가 충분히 줄지
            # 않으면 그 자리에서 완전 접선으로 바꾸고 같은 상태를 풉니다.
            full_tangent = True
            tangent = structural_response(model, displacement, rotations, prepared, solution.element_history, geometric)[1]
            _, moving_mass, configuration_inertia, velocity_inertia, _ = inertial_response(model, displacement, rotations, velocity, acceleration - gravity.reshape(-1, 6), prepared, mass, geometric, derivatives=True, exact_tangent=True)
        previous_relative = relative
        effective = T.T @ (tangent + configuration_inertia - follower_tangent + _link_geometric_matrix(model, rotations, residual_full)) @ T
        effective += T.T @ (moving_mass @ A + (current_damping + velocity_inertia) @ V)
        correction = np.asarray(T @ solve_linear(effective, residual))
        changes = correction.reshape(-1, 6)
        coordinate_changes = changes.copy()
        if rotation_jacobians is not None:
            coordinate_changes[:, 3:] = (rotation_jacobians @ changes[:, 3:, None])[..., 0]
        for slave, (master, axis_index) in joints.items():
            axis = rotations[master][:, axis_index]
            coordinate_changes[slave, 3 + axis_index] = axis @ (changes[slave, 3:] - changes[master, 3:])
        displacement += coordinate_changes
        displacement.ravel()[model.fixed] = 0.
        # 최종 자세는 Newton 경로와 무관하게 같은 predictor와 같은 좌표에서
        # 재구성한다. 기존 apply_increment는 정적 해석의 공간 증분용으로 남긴다.
        rotations = rotation_exp_many(displacement[:, 3:] - predictor[:, 3:]) @ rotation_predictor
        enforce_links(model, displacement, rotations, pitch)
    raise ValueError("Newmark equilibrium did not converge")
