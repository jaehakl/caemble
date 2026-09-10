"""평형과 시간 전진: 조립된 식을 실제 구조 응답으로 바꾼다.

선형 정적은 K u=f, 모달은 K phi=omega² M phi, 동역학은
M a+C v+f_internal=f_external이다. 입력 상태와 trial 상태를 분리하고
수렴한 단계만 반환하므로 실패/재시도 때문에 소성 이력이 누적되지 않는다.
"""

import warnings
from copy import deepcopy

import numpy as np
from scipy import linalg, sparse
from scipy.sparse.linalg import MatrixRankWarning, eigsh, spsolve

from .constraints import (
    constraint_transform,
    contact_response,
    enforce_links,
    revolute_joints,
    spring_gradient,
    spring_gradient_tangent,
    support_reactions,
)
from .formulation import (
    geometric_matrix,
    inertial_response,
    strain_rate_damping,
    structural_response,
)
from .model import StructuralSolution
from .rotations import (
    cross,
    rotation_exp,
    rotation_exp_many,
    rotation_log_many,
    skew,
    skew_many,
)


def solve_linear(matrix, rhs):
    """대각 스케일링 후 sparse LU. 구조 기구를 임의의 작은 스프링으로 숨기지 않는다."""
    matrix = sparse.csr_matrix(matrix)
    if matrix.shape[0] == 0:
        return np.empty(0, dtype=np.result_type(matrix.dtype, np.asarray(rhs).dtype))
    diagonal = np.abs(matrix.diagonal())
    row_scale = np.asarray(abs(matrix).max(axis=1).toarray()).ravel()
    if np.any(row_scale == 0):
        raise ValueError("structural system is singular; check supports and active connections")
    # 공진 근처에는 대각항이 0이어도 전체 행렬이 가역일 수 있습니다.
    # 이때는 행의 크기를 써서 1/sqrt(tiny)의 overflow를 피합니다.
    diagonal = np.where(diagonal > row_scale * np.finfo(float).eps, diagonal, row_scale)
    scale = 1 / np.sqrt(diagonal)
    D = sparse.diags(scale)
    with warnings.catch_warnings():
        warnings.simplefilter("error", MatrixRankWarning)
        try:
            value = scale * spsolve((D @ matrix @ D).tocsc(), scale * rhs)
        except (MatrixRankWarning, RuntimeError) as error:
            raise ValueError("structural system is singular; check supports and active connections") from error
    if not np.all(np.isfinite(value)):
        raise ValueError("structural solve produced non-finite values")
    residual = np.linalg.norm(matrix @ value - rhs) / max(np.linalg.norm(rhs), np.finfo(float).tiny)
    if residual > 1e-8 and np.linalg.norm(rhs) > 1e-12:
        raise ValueError(f"linear solve relative residual {residual:g} exceeds 1e-8")
    return value


def initial_solution(model):
    n = len(model.points)
    return StructuralSolution(np.zeros((n, 6)), np.zeros((n, 6)), np.zeros((n, 6)), np.tile(np.eye(3), (n, 1, 1)), np.zeros((n, 6)), {}, [None] * len(model.elements), [None] * len(model.elements))


def apply_increment(model, displacement, orientations, increment, pitch=0.0):
    changes = increment.reshape(-1, 6)
    coordinate_changes = changes.copy()
    for slave, (master, axis_index) in revolute_joints(model).items():
        axis = orientations[master][:, axis_index]
        coordinate_changes[slave, 3 + axis_index] = axis @ (changes[slave, 3:] - changes[master, 3:])
    displacement = displacement + coordinate_changes
    orientations = rotation_exp_many(changes[:, 3:]) @ orientations
    displacement.ravel()[model.fixed] = 0
    enforce_links(model, displacement, orientations, pitch)
    return displacement, orientations


def kinematic_rates(model, orientations, velocity, acceleration, pitch_rate=0., pitch_acceleration=0., transform=None, velocity_factor=0., acceleration_factor=0., *, joint_rates=None, rotation_jacobians=None):
    """강체 연결의 속도·가속도와 Newton 증분에 대한 미분입니다.

    위치를 맞춘 뒤 속도도 단순 복사하면 편심 질량의 원운동을 놓칩니다.
    팔 r에 대해 v_slave=v_master+omega×r,
    a_slave=a_master+alpha×r+omega×(omega×r)를 사용합니다.
    마지막 항이 구심가속도이며 로터 하중의 중요한 부분입니다.
    """
    velocity, acceleration = velocity.copy(), acceleration.copy()
    joints = revolute_joints(model)
    if joint_rates is None:
        joint_rates = {}
        for slave, (master, axis_index) in joints.items():
            axis = orientations[master][:, axis_index]
            joint_rates[slave] = (axis @ (velocity[slave, 3:] - velocity[master, 3:]), axis @ (acceleration[slave, 3:] - acceleration[master, 3:]))
    velocity.ravel()[model.fixed] = 0.
    acceleration.ravel()[model.fixed] = 0.
    T = constraint_transform(model, orientations) if transform is None else transform
    rate_transform = T
    if rotation_jacobians is not None:
        # T는 공간 회전 증분을 전달한다. Newmark의 각속도/각가속도는
        # 고정 predictor 주위 회전 좌표로 적분하므로 dexp 역행렬을 한 번 더 쓴다.
        rotational = (6 * np.arange(len(model.points))[:, None] + np.arange(3, 6)).ravel()
        rows = np.repeat(rotational.reshape(-1, 3), 3, axis=1).ravel()
        columns = np.tile(rotational.reshape(-1, 3), (1, 3)).ravel()
        correction = sparse.csr_matrix(((rotation_jacobians - np.eye(3)).ravel(), (rows, columns)), shape=(model.size, model.size))
        rate_transform = T + correction @ T
    if not model.links:
        return velocity, acceleration, velocity_factor * rate_transform, acceleration_factor * rate_transform
    # 연결되지 않은 절점은 V=cv*T, A=ca*T 그대로다. 강체 연결에 참여하는
    # 몇 절점의 행만 작은 배열로 꺼내 갱신한다. 전체 자유도 수의 제곱에
    # 비례하는 dense 배열을 매 Newton 반복에서 복사할 필요가 없다.
    linked_nodes = sorted({node for master, slave, _ in model.links for node in (master, slave)})
    offsets = {node: 6 * index for index, node in enumerate(linked_nodes)}
    linked_rows = (6 * np.asarray(linked_nodes)[:, None] + np.arange(6)).ravel()
    linked_transform = T[linked_rows].toarray()
    linked_rate_transform = rate_transform[linked_rows].toarray()
    V, A = velocity_factor * linked_rate_transform, acceleration_factor * linked_rate_transform
    pitch_roots = set() if model.rotor is None else set(model.rotor["bladeRootNodes"])
    remaining, completed = list(model.links), set()
    dependent = {slave for _, slave, _ in remaining}
    while remaining:
        ready = [link for link in remaining if link[0] not in dependent or link[0] in completed]
        if not ready:
            raise ValueError("cyclic rigid node links")
        for master, slave, components in ready:
            arm0 = model.points[slave] - model.points[master]
            arm = orientations[master] @ arm0
            omega, alpha = velocity[master, 3:], acceleration[master, 3:]
            master_translation = slice(offsets[master], offsets[master] + 3)
            master_rotation = slice(offsets[master] + 3, offsets[master] + 6)
            spin = linked_transform[master_rotation]
            arm_derivative = -skew(arm) @ spin
            target_v = velocity[master, :3] + cross(omega, arm)
            target_a = acceleration[master, :3] + cross(alpha, arm) + cross(omega, cross(omega, arm))
            target_V = V[master_translation] - skew(arm) @ V[master_rotation] + skew(omega) @ arm_derivative
            target_A = (
                A[master_translation] - skew(arm) @ A[master_rotation]
                + (-skew(cross(omega, arm)) - skew(omega) @ skew(arm)) @ V[master_rotation]
                + (skew(alpha) + skew(omega) @ skew(omega)) @ arm_derivative
            )
            for component in components:
                row = offsets[slave] + component
                if component < 3:
                    velocity[slave, component], acceleration[slave, component] = target_v[component], target_a[component]
                    V[row], A[row] = target_V[component], target_A[component]
                else:
                    velocity[slave, component], acceleration[slave, component] = velocity[master, component], acceleration[master, component]
                    V[row], A[row] = V[offsets[master] + component], A[offsets[master] + component]
            if slave in joints:
                axis = orientations[master][:, joints[slave][1]]
                rate, second_rate = joint_rates[slave]
                rows = slice(offsets[slave] + 3, offsets[slave] + 6)
                joint_row = axis @ (linked_transform[rows] - spin)
                axis_derivative = -skew(axis) @ spin
                rate_derivative = velocity_factor * joint_row
                acceleration_derivative = acceleration_factor * joint_row
                velocity[slave, 3:] = omega + axis * rate
                acceleration[slave, 3:] = alpha + axis * second_rate + cross(omega, axis * rate)
                V[rows] = V[master_rotation] + np.outer(axis, rate_derivative) + rate * axis_derivative
                A[rows] = (
                    A[master_rotation] + np.outer(axis, acceleration_derivative)
                    - skew(axis * rate) @ V[master_rotation]
                    + (second_rate * np.eye(3) + rate * skew(omega)) @ axis_derivative
                    + skew(omega) @ np.outer(axis, rate_derivative)
                )
            elif slave in pitch_roots:
                axis = orientations[master] @ (arm0 / np.linalg.norm(arm0))
                # IEC의 양의 feather pitch는 이 모델의 바깥쪽 span 축에서
                # 음의 오른손 회전입니다. 위치와 속도에 같은 부호를 씁니다.
                pitch_velocity, pitch_accel = -axis * pitch_rate, -axis * pitch_acceleration
                velocity[slave, 3:] = omega + pitch_velocity
                acceleration[slave, 3:] = alpha + cross(omega, pitch_velocity) + pitch_accel
                rows = slice(offsets[slave] + 3, offsets[slave] + 6)
                V[rows] = V[master_rotation] - skew(pitch_velocity) @ spin
                A[rows] = A[master_rotation] - skew(pitch_velocity) @ V[master_rotation] - (skew(omega) @ skew(pitch_velocity) + skew(pitch_accel)) @ spin
            completed.add(slave)
            remaining = [link for link in remaining if link[1] != slave]
    derivatives = []
    for updated, factor in ((V, velocity_factor), (A, acceleration_factor)):
        correction = updated - factor * linked_rate_transform
        rows, columns = np.nonzero(correction)
        change = sparse.csr_matrix((correction[rows, columns], (linked_rows[rows], columns)), shape=T.shape)
        derivatives.append(factor * rate_transform + change)
    return velocity, acceleration, *derivatives


def _link_geometric_matrix(model, orientations, residual):
    """T(q).T residual을 미분할 때 생기는 편심 연결의 기하항입니다."""
    effective = np.asarray(residual).reshape(-1, 6).copy()
    rows, columns, values = [], [], []
    joints = revolute_joints(model)
    remaining = list(model.links)
    while remaining:
        masters = {master for master, _, _ in remaining}
        leaves = [link for link in remaining if link[1] not in masters]
        if not leaves:
            raise ValueError("cyclic rigid node links")
        for master, slave, components in leaves:
            arm = orientations[master] @ (model.points[slave] - model.points[master])
            wrench = np.zeros(6)
            wrench[components] = effective[slave, components]
            if slave in joints:
                wrench = effective[slave].copy()
                axis_index = joints[slave][1]
                axis = orientations[master][:, axis_index]
                master_rows = np.arange(6 * master + 3, 6 * master + 6)
                torque_rows = np.r_[np.arange(6 * slave + 3, 6 * slave + 6), master_rows]
                block = np.outer(np.r_[axis, -axis], -cross(axis, wrench[3:]))
                rows.extend(np.repeat(torque_rows, 3))
                columns.extend(np.tile(master_rows, 6))
                values.extend(block.ravel())
            master_rows = np.arange(6 * master + 3, 6 * master + 6)
            block = np.dot(arm, wrench[:3]) * np.eye(3) - np.outer(arm, wrench[:3])
            rows.extend(np.repeat(master_rows, 3))
            columns.extend(np.tile(master_rows, 3))
            values.extend(block.ravel())
            effective[master] += wrench
            effective[master, 3:] += cross(arm, wrench[:3])
            remaining = [link for link in remaining if link[1] != slave]
    return sparse.csr_matrix((values, (rows, columns)), shape=(model.size, model.size))


def static_analysis(model, prepared, stiffness, mass, tolerance=1e-8, max_iterations=30, geometric=False, cancellation=None):
    """하중을 나누어 평형을 찾고, 편심 단면의 중력 모멘트도 현재 자세에서 푼다."""
    solution = initial_solution(model)
    gravity = np.zeros(model.size)
    gravity.reshape(-1, 6)[:, :3] = model.gravity
    external = model.force.ravel() + mass @ gravity
    rotating_gravity = geometric and np.any(gravity)
    zero_motion = np.zeros_like(solution.displacement)
    nonlinear = geometric or bool(model.contacts) or any(e.material["model"] == "mechanics.j2-plasticity@1" for e in model.elements)
    if not nonlinear:
        T = constraint_transform(model, solution.orientations)
        solution.displacement = np.asarray(T @ solve_linear(T.T @ stiffness @ T, T.T @ external)).reshape(-1, 6)
        solution.orientations = np.asarray([rotation_exp(value[3:]) for value in solution.displacement])
        for slave, (master, axis_index) in revolute_joints(model).items():
            solution.displacement[slave, 3 + axis_index] -= solution.displacement[master, 3 + axis_index]
        solution.iterations = 1
        internal, _, history, stress, energy = structural_response(model, solution.displacement, solution.orientations, prepared, None)
    else:
        factor, increment = 0.0, 0.25
        while factor < 1.0 - 1e-12:
            target = min(1.0, factor + increment)
            displacement, rotations = solution.displacement.copy(), solution.orientations.copy()
            converged = False
            for iteration in range(max_iterations):
                if cancellation is not None:
                    cancellation.raise_if_cancelled()
                internal, tangent, history, stress, energy = structural_response(model, displacement, rotations, prepared, solution.element_history, geometric)
                current_external = target * external
                if rotating_gravity:
                    # 단면 무게중심이 기준선에서 벗어나면 M의 병진-회전 연결이
                    # 중력 모멘트를 만든다. 물체가 회전할 때 이 팔도 함께 돈다.
                    # v=0, a=g를 관성식에 넣으면 현재 M(q)g와 d(Mg)/dq를
                    # 같은 질량 정의에서 얻는다. 실제 관성 하중을 추가하는 것은 아니다.
                    weight, _, weight_tangent, _, _ = inertial_response(model, displacement, rotations, zero_motion, gravity.reshape(-1, 6), prepared, mass, geometric, derivatives=True)
                    current_external = target * (model.force.ravel() + weight)
                    tangent = tangent - target * weight_tangent
                T = constraint_transform(model, rotations)
                residual = T.T @ (current_external - internal)
                relative = np.linalg.norm(residual) / max(np.linalg.norm(T.T @ current_external), 1.0)
                if relative <= tolerance:
                    converged = True
                    break
                tangent = tangent + _link_geometric_matrix(model, rotations, current_external - internal)
                correction = np.asarray(T @ solve_linear(T.T @ tangent @ T, residual))
                # 같은 확정 재료 이력에서 후보를 비교한다. 실패한 line-search는 버린다.
                for reduction in range(12):
                    candidate_u, candidate_R = apply_increment(model, displacement, rotations, correction * 0.5**reduction)
                    candidate_force = structural_response(model, candidate_u, candidate_R, prepared, solution.element_history, geometric, approximate_tangent=True)[0]
                    candidate_external = target * external
                    if rotating_gravity:
                        weight = inertial_response(model, candidate_u, candidate_R, zero_motion, gravity.reshape(-1, 6), prepared, mass, geometric)[0]
                        candidate_external = target * (model.force.ravel() + weight)
                    candidate_residual = candidate_external - candidate_force
                    # 가는 보는 축/굽힘 강성 차이가 큽니다. 원시 힘의 norm만
                    # 줄이면 유효한 굽힘 Newton 증분을 지나치게 잘라 버립니다.
                    # 일(work)에 해당하는 방향 잔차로 backtracking합니다.
                    if abs(correction @ candidate_residual) < abs(correction @ (current_external - internal)):
                        displacement, rotations = candidate_u, candidate_R
                        break
                else:
                    break
            if not converged:
                increment /= 2
                if increment < 1e-6:
                    raise ValueError("nonlinear equilibrium did not converge after load-step reduction")
                continue
            solution.displacement, solution.orientations = displacement, rotations
            solution.element_history = history
            solution.iterations += iteration + 1
            factor = target
            increment = min(2 * increment, 1.0 - factor)
    if rotating_gravity:
        weight = inertial_response(model, solution.displacement, solution.orientations, zero_motion, gravity.reshape(-1, 6), prepared, mass, geometric)[0]
        external = model.force.ravel() + weight
    solution.reaction = support_reactions(model, solution.orientations, internal - external)
    T = constraint_transform(model, solution.orientations)
    solution.residual = float(np.linalg.norm(T.T @ (internal - external)) / max(np.linalg.norm(T.T @ external), 1.0))
    solution.element_history, solution.stresses = history, stress
    solution.strain_energy = float(energy)
    solution.contact_history = contact_response(model.points, solution.displacement, model.contacts)[2] if model.contacts else []
    return solution


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
    reduced_mass = (T.T @ moving_mass @ T).toarray()
    if len(rhs):
        diagonal = np.abs(np.diag(reduced_mass))
        scaling = np.ones(len(rhs))
        scaling[diagonal > 0] = 1 / np.sqrt(diagonal[diagonal > 0])
        values, vectors = linalg.eigh(reduced_mass * np.outer(scaling, scaling))
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


def modal_analysis(model, stiffness, mass, count):
    """질량 없는 shell drilling 자유도는 정적 축약한다. 가짜 관성을 추가하지 않는다."""
    T = constraint_transform(model, np.tile(np.eye(3), (len(model.points), 1, 1)))
    K, M = (T.T @ stiffness @ T).toarray(), (T.T @ mass @ T).toarray()
    if not len(M) or count < 1:
        raise ValueError("modal analysis requires free degrees of freedom and a positive mode count")
    # 기울어진 shell의 drilling 무질량 방향은 xyz 중 어느 하나가 아닙니다.
    # 대각항만 검사하면 놓치므로 질량의 실제 영공간을 구해 축약합니다.
    diagonal = np.abs(np.diag(M))
    scaling = np.ones(len(M))
    scaling[diagonal > 0] = 1 / np.sqrt(diagonal[diagonal > 0])
    mass_values, mass_vectors = linalg.eigh(M * np.outer(scaling, scaling))
    mass_tolerance = max(np.max(np.abs(mass_values)), 1.) * 1e-12
    if np.min(mass_values) < -mass_tolerance:
        raise ValueError("modal mass matrix must be positive semidefinite")
    moving = mass_values > mass_tolerance
    if not np.any(moving):
        raise ValueError("modal analysis requires physical mass")
    S = np.eye(len(M)) if np.all(moving) else scaling[:, None] * mass_vectors[:, moving]
    null = scaling[:, None] * mass_vectors[:, ~moving]
    if null.shape[1]:
        S -= null @ linalg.solve(null.T @ K @ null, null.T @ K @ S, assume_a="sym")
    Kr, Mr = S.T @ K @ S, S.T @ M @ S
    if count < len(Kr) - 1:
        try:
            values, vectors = eigsh(sparse.csr_matrix(Kr), k=count, M=sparse.csr_matrix(Mr), sigma=0.0, which="LM", tol=1e-11)
        except RuntimeError:
            # 자유롭게 떠 있는 구조물은 여섯 강체 모드 때문에 K가 특이합니다.
            # 0 근처 shift-invert가 실패해도 질량 고유치 문제 자체는 유효합니다.
            values, vectors = linalg.eigh(Kr, Mr)
    else:
        values, vectors = linalg.eigh(Kr, Mr)
    # 일부 강체 모드만 계산된 경우 그 작은 고유치끼리 비교하면 부동소수점
    # 잡음을 진동 모드로 오인합니다. 실제 K/M의 주파수 척도도 함께 씁니다.
    zero_tolerance = max(np.max(np.abs(np.diag(Kr)) / np.diag(Mr)), np.max(np.abs(values), initial=0)) * 1e-12
    order = np.argsort(values)
    positive = order[values[order] > zero_tolerance]
    if len(positive) < count and len(values) < len(Kr):
        values, vectors = linalg.eigh(Kr, Mr)
        order = np.argsort(values)
        positive = order[values[order] > max(zero_tolerance, np.max(np.abs(values), initial=0) * 1e-12)]
    selected = positive[:count]
    if len(selected) < count:
        raise ValueError("requested more positive modes than the constrained model has")
    values, vectors = values[selected], vectors[:, selected]
    modes = np.asarray(T @ (S @ vectors)).T.reshape(count, len(model.points), 6)
    for value, vector in zip(values, vectors.T):
        physical = S @ vector
        residual = np.linalg.norm(K @ physical - value * M @ physical) / max(np.linalg.norm(K @ physical), 1e-30)
        if residual > 1e-8:
            raise ValueError("modal eigenpair did not meet the 1e-8 residual criterion")
    return {"frequencies": np.sqrt(values) / (2 * np.pi), "modes": modes}


def buckling_analysis(model, stiffness, displacement, prepared, count):
    T = constraint_transform(model, np.tile(np.eye(3), (len(model.points), 1, 1)))
    K = (T.T @ stiffness @ T).toarray()
    G = (T.T @ geometric_matrix(model, displacement, prepared) @ T).toarray()
    # -G는 양정일 필요가 없다. modal용 SPD eigensolver에 억지로 넣지 않는다.
    values, vectors = linalg.eig(K, -G)
    usable = np.flatnonzero(np.isfinite(values) & (np.abs(values.imag) < 1e-8 * np.maximum(1, np.abs(values.real))) & (values.real > 0))
    selected = usable[np.argsort(values[usable].real)][:count]
    if len(selected) < count:
        raise ValueError("preload has fewer positive finite buckling factors than requested")
    values, vectors = values[selected].real, vectors[:, selected].real
    for value, vector in zip(values, vectors.T):
        if np.linalg.norm(K @ vector + value * G @ vector) / max(np.linalg.norm(K @ vector), 1e-30) > 1e-8:
            raise ValueError("buckling eigenpair did not meet the 1e-8 residual criterion")
    modes = np.asarray(T @ vectors).T.reshape(len(values), len(model.points), 6)
    return {"factors": values, "modes": modes}


def harmonic_analysis(model, stiffness, mass, damping, frequencies):
    T = constraint_transform(model, np.tile(np.eye(3), (len(model.points), 1, 1)))
    K, M, C = (T.T @ matrix @ T for matrix in (stiffness, mass, damping))
    response = []
    for frequency in frequencies:
        omega = 2 * np.pi * frequency
        value = solve_linear(K - omega**2 * M + 1j * omega * C, T.T @ model.force.ravel())
        response.append(np.asarray(T @ value).reshape(-1, 6))
    return {"frequencies": np.asarray(frequencies), "response": np.asarray(response)}


def _rotation_coordinate_jacobians(vectors):
    """R=exp(phi)*R_predictor에서 공간 증분을 phi 증분으로 바꾼다.

    회전은 교환되지 않는다. phi에 공간 Newton 증분을 그대로 더하면 결과가
    반복 경로에 의존한다. dexp(phi)^(-1)=I-[phi]/2+A[phi]^2를 사용한다.
    phi=0에서는 급수를 써서 큰 수끼리 빼는 계산 오차를 피한다.
    """
    angles = np.linalg.norm(vectors, axis=1)
    coefficient = np.empty_like(angles)
    small = angles < 1e-4
    coefficient[small] = 1 / 12 + angles[small]**2 / 720 + angles[small]**4 / 30240
    coefficient[~small] = (1 - .5 * angles[~small] / np.tan(angles[~small] / 2)) / angles[~small]**2
    generators = skew_many(vectors)
    return np.eye(3) - .5 * generators + coefficient[:, None, None] * (generators @ generators)


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
