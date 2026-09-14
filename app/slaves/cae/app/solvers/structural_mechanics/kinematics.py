"""Constraint-consistent positions, rotations, velocities and accelerations."""

import numpy as np
from scipy import sparse

from .constraints import constraint_transform, enforce_links, revolute_joints
from .rotations import cross, rotation_exp_many, skew, skew_many


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
    # 초기 가속도처럼 Jacobian 배율이 모두 0이면 값만 전파한다. 그 외에도
    # attachment surface의 절점 수 × 전체 모델 DOF인 dense 배열을 만들지
    # 않고 링크 행만 sparse로 유지한다.
    derivatives_requested = velocity_factor != 0 or acceleration_factor != 0
    if derivatives_requested:
        linked_nodes = sorted({node for master, slave, _ in model.links for node in (master, slave)})
        offsets = {node: 6 * index for index, node in enumerate(linked_nodes)}
        linked_rows = (6 * np.asarray(linked_nodes)[:, None] + np.arange(6)).ravel()
        linked_transform = T[linked_rows].tocsr()
        linked_rate_transform = rate_transform[linked_rows].tocsr()
        V = (velocity_factor * linked_rate_transform).tolil()
        A = (acceleration_factor * linked_rate_transform).tolil()
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
            target_v = velocity[master, :3] + cross(omega, arm)
            target_a = acceleration[master, :3] + cross(alpha, arm) + cross(omega, cross(omega, arm))
            if derivatives_requested:
                master_translation = slice(offsets[master], offsets[master] + 3)
                master_rotation = slice(offsets[master] + 3, offsets[master] + 6)
                spin = linked_transform[master_rotation]
                arm_derivative = sparse.csr_matrix(-skew(arm)) @ spin
                rotation_V = V[master_rotation].tocsr()
                target_V = (
                    V[master_translation].tocsr()
                    - sparse.csr_matrix(skew(arm)) @ rotation_V
                    + sparse.csr_matrix(skew(omega)) @ arm_derivative
                )
                target_A = (
                    A[master_translation].tocsr()
                    - sparse.csr_matrix(skew(arm)) @ A[master_rotation].tocsr()
                    + sparse.csr_matrix(-skew(cross(omega, arm)) - skew(omega) @ skew(arm)) @ rotation_V
                    + sparse.csr_matrix(skew(alpha) + skew(omega) @ skew(omega)) @ arm_derivative
                )
            for component in components:
                if component < 3:
                    velocity[slave, component], acceleration[slave, component] = target_v[component], target_a[component]
                    if derivatives_requested:
                        row = offsets[slave] + component
                        V[row], A[row] = target_V.getrow(component), target_A.getrow(component)
                else:
                    velocity[slave, component], acceleration[slave, component] = velocity[master, component], acceleration[master, component]
                    if derivatives_requested:
                        row = offsets[slave] + component
                        V[row], A[row] = V[offsets[master] + component], A[offsets[master] + component]
            if slave in joints:
                axis = orientations[master][:, joints[slave][1]]
                rate, second_rate = joint_rates[slave]
                velocity[slave, 3:] = omega + axis * rate
                acceleration[slave, 3:] = alpha + axis * second_rate + cross(omega, axis * rate)
                if derivatives_requested:
                    rows = slice(offsets[slave] + 3, offsets[slave] + 6)
                    joint_row = sparse.csr_matrix(axis.reshape(1, 3)) @ (linked_transform[rows] - spin)
                    axis_derivative = sparse.csr_matrix(-skew(axis)) @ spin
                    rate_derivative = velocity_factor * joint_row
                    acceleration_derivative = acceleration_factor * joint_row
                    axis_column = sparse.csr_matrix(axis.reshape(3, 1))
                    axis_rate = axis_column @ rate_derivative
                    V[rows] = V[master_rotation].tocsr() + axis_rate + rate * axis_derivative
                    A[rows] = (
                        A[master_rotation].tocsr() + axis_column @ acceleration_derivative
                        - sparse.csr_matrix(skew(axis * rate)) @ V[master_rotation].tocsr()
                        + sparse.csr_matrix(second_rate * np.eye(3) + rate * skew(omega)) @ axis_derivative
                        + sparse.csr_matrix(skew(omega)) @ axis_rate
                    )
            elif slave in pitch_roots:
                axis = orientations[master] @ (arm0 / np.linalg.norm(arm0))
                # IEC의 양의 feather pitch는 이 모델의 바깥쪽 span 축에서
                # 음의 오른손 회전입니다. 위치와 속도에 같은 부호를 씁니다.
                pitch_velocity, pitch_accel = -axis * pitch_rate, -axis * pitch_acceleration
                velocity[slave, 3:] = omega + pitch_velocity
                acceleration[slave, 3:] = alpha + cross(omega, pitch_velocity) + pitch_accel
                if derivatives_requested:
                    rows = slice(offsets[slave] + 3, offsets[slave] + 6)
                    V[rows] = V[master_rotation].tocsr() - sparse.csr_matrix(skew(pitch_velocity)) @ spin
                    A[rows] = (
                        A[master_rotation].tocsr()
                        - sparse.csr_matrix(skew(pitch_velocity)) @ V[master_rotation].tocsr()
                        - sparse.csr_matrix(skew(omega) @ skew(pitch_velocity) + skew(pitch_accel)) @ spin
                    )
            completed.add(slave)
            remaining = [link for link in remaining if link[1] != slave]
    if not derivatives_requested:
        empty = sparse.csr_matrix(T.shape)
        return velocity, acceleration, empty, empty
    derivatives = []
    for updated, factor in ((V, velocity_factor), (A, acceleration_factor)):
        correction = (updated.tocsr() - factor * linked_rate_transform).tocoo()
        change = sparse.csr_matrix(
            (correction.data, (linked_rows[correction.row], correction.col)), shape=T.shape,
        )
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
