"""지지와 연결: 힘을 큰 숫자로 덧붙이는 대신 종속 자유도를 제거한다.

강체 연결은 u_slave = u_master + theta_master × r로 선형화한다.
유한회전에서는 현재 팔 길이 r=R_master r0를 사용한다. 이 변환의 전치로
힘을 모으므로 편심 하중의 힘뿐 아니라 모멘트와 가상일도 전달된다.
"""

import numpy as np
from scipy import sparse
from scipy.spatial import cKDTree

from .rotations import cross, rotation_exp, skew


def revolute_joints(model):
    """병진 3개와 회전 2개를 연결하면 남은 master 국소 축이 회전축입니다."""
    joints = {}
    for master, slave, components in model.links:
        # 길이 6 이하의 연결 목록이다. NumPy 배열을 반복 검색하지 않는다.
        selected = set(components)
        free = [axis for axis in range(3) if axis + 3 not in selected]
        if {0, 1, 2}.issubset(selected) and len(free) == 1:
            joints[slave] = (master, free[0])
    return joints


def spring_gradient(model, orientations, a, b, ratio):
    """스프링 좌표의 가상변위를 공간 절점 운동으로 미분합니다.

    회전 조인트의 q는 master에 대한 상대각입니다. 따라서 q에 작용하는
    토크는 slave와 master에 반대로 전달되어 케이싱 반력도 보존됩니다.
    """
    gradient = np.zeros(model.size)
    joints = revolute_joints(model)
    for dof, weight in ((a, 1.), (b, -ratio)):
        if dof < 0:
            continue
        node, component = divmod(dof, 6)
        if node in joints and component == joints[node][1] + 3:
            master, axis_index = joints[node]
            axis = orientations[master][:, axis_index]
            gradient[6 * node + 3:6 * node + 6] += weight * axis
            gradient[6 * master + 3:6 * master + 6] -= weight * axis
        else:
            gradient[dof] += weight
    return gradient


def spring_gradient_tangent(model, orientations, a, b, ratio):
    """상대각의 축이 master와 함께 회전할 때 힘 방향이 변하는 미분입니다."""
    rows, columns, values = [], [], []
    joints = revolute_joints(model)
    for dof, weight in ((a, 1.), (b, -ratio)):
        node, component = divmod(dof, 6)
        if dof >= 0 and node in joints and component == joints[node][1] + 3:
            master, axis_index = joints[node]
            change = -weight * skew(orientations[master][:, axis_index])
            master_rows = np.arange(6 * master + 3, 6 * master + 6)
            slave_rows = np.arange(6 * node + 3, 6 * node + 6)
            for target, block in ((slave_rows, change), (master_rows, -change)):
                rows.extend(np.repeat(target, 3))
                columns.extend(np.tile(master_rows, 3))
                values.extend(block.ravel())
    return sparse.csr_matrix((values, (rows, columns)), shape=(model.size, model.size))


def constraint_transform(model, orientations):
    dependencies = {}
    fixed = set(map(int, model.fixed))
    joints = revolute_joints(model)
    joint_coordinates = {6 * slave + 3 + axis for slave, (_, axis) in joints.items()}
    for master, slave, components in model.links:
        arm = orientations[master] @ (model.points[slave] - model.points[master])
        coupling = -skew(arm)
        for component in components:
            index = 6 * slave + int(component)
            expression = {6 * master + int(component): 1.0}
            if component < 3:
                expression.update({6 * master + 3 + k: coupling[component, k] for k in range(3) if coupling[component, k] != 0})
            if index in dependencies:
                raise ValueError("a dependent degree of freedom has more than one rigid constraint")
            dependencies[index] = expression
        if slave in joints:
            axis_index = joints[slave][1]
            axis = orientations[master][:, axis_index]
            # 음수 token은 물리적 공간 성분이 아니라 독립 상대각 q를 뜻합니다.
            token = -(6 * slave + 3 + axis_index + 1)
            for component in range(3):
                dependencies[6 * slave + 3 + component] = {6 * master + 3 + component: 1., token: axis[component]}
    independent = [int(i) for i in model.active if i not in fixed and (i not in dependencies or i in joint_coordinates)]
    column = {index: j for j, index in enumerate(independent)}
    resolved = {}

    def expand(index, ancestors):
        if index < 0:
            coordinate = -index - 1
            return {column[coordinate]: 1.} if coordinate in column else {}
        if index in resolved:
            return resolved[index]
        if index in ancestors:
            raise ValueError("cyclic rigid constraints")
        if (index in fixed and index not in joint_coordinates) or (index not in column and index not in dependencies):
            return {}
        if index in column and index not in dependencies:
            return {column[index]: 1.0}
        result = {}
        for parent, coefficient in dependencies[index].items():
            for j, weight in expand(parent, ancestors | {index}).items():
                result[j] = result.get(j, 0.0) + coefficient * weight
        resolved[index] = result
        return result

    rows, columns, values = [], [], []
    for index in model.active:
        for j, value in expand(int(index), set()).items():
            rows.append(index)
            columns.append(j)
            values.append(value)
    return sparse.csr_matrix((values, (rows, columns)), shape=(model.size, len(independent)))


def enforce_links(model, displacement, orientations, pitch=0.0):
    """이미 정한 master 운동에서 slave 위치/자세를 구성한다.

    연결 선언 순서가 아닌 의존 순서로 처리한다. 피치 연결의 상대 회전은
    prescribed actuator motion이며 구조 내부에서 별도 rotor를 적분하지 않는다.
    """
    remaining = list(model.links)
    completed = set()
    dependent_nodes = {slave for _, slave, _ in remaining}
    pitch_roots = set() if model.rotor is None else set(model.rotor["bladeRootNodes"])
    joints = revolute_joints(model)
    while remaining:
        ready = [(a, b, c) for a, b, c in remaining if a not in dependent_nodes or a in completed]
        if not ready:
            raise ValueError("cyclic rigid node links")
        for master, slave, components in ready:
            arm0 = model.points[slave] - model.points[master]
            target = model.points[master] + displacement[master, :3] + orientations[master] @ arm0
            for component in components:
                if component < 3:
                    displacement[slave, component] = target[component] - model.points[slave, component]
                else:
                    displacement[slave, component] = displacement[master, component]
            if slave in joints:
                axis_index = joints[slave][1]
                relative_angle = displacement[slave, 3 + axis_index]
                orientations[slave] = orientations[master] @ rotation_exp(np.eye(3)[axis_index] * relative_angle)
            elif all(component in components for component in (3, 4, 5)):
                relative = np.eye(3)
                if slave in pitch_roots:
                    axis = arm0 / np.linalg.norm(arm0)
                    # IEC 양의 feather pitch는 뿌리→끝 축의 음의 회전이다.
                    relative = rotation_exp(-axis * pitch)
                orientations[slave] = orientations[master] @ relative
            completed.add(slave)
            remaining = [item for item in remaining if item[1] != slave]


def support_reactions(model, orientations, nodal_residual):
    """내부 링크 반력을 제거하고 prescribed 외부 지지 반력을 회복한다.

    slave의 힘 F는 master에도 F와 r×F로 전달된다. raw 잔차를 그대로
    출력하면 고정 master 대신 하중을 받은 slave에 반력이 남는다.
    연결 말단부터 이 가상일 변환을 적용한 뒤 독립된 fixed DOF만 반환한다.
    자유 DOF의 수치 잔차, 내부 링크 토크, ground spring 내부력은 제외한다.
    """
    effective = np.asarray(nodal_residual).reshape(-1, 6).copy()
    remaining = list(model.links)
    dependent_dofs = set()
    joints = revolute_joints(model)
    while remaining:
        masters = {master for master, _, _ in remaining}
        leaves = [link for link in remaining if link[1] not in masters]
        if not leaves:
            raise ValueError("cyclic rigid node links")
        for master, slave, components in leaves:
            wrench = np.zeros(6)
            wrench[components] = effective[slave, components]
            dependent_dofs.update(6 * slave + int(component) for component in components)
            if slave in joints:
                # master의 가상 회전은 slave의 세 공간 회전 모두에 전달된다.
                wrench[3:] = effective[slave, 3:]
                dependent_dofs.update(range(6 * slave + 3, 6 * slave + 6))
            arm = orientations[master] @ (model.points[slave] - model.points[master])
            effective[master, :3] += wrench[:3]
            effective[master, 3:] += wrench[3:] + cross(arm, wrench[:3])
            remaining = [link for link in remaining if link[1] != slave]
    reactions = np.zeros_like(effective)
    supports = np.asarray([int(dof) for dof in model.fixed if dof not in dependent_dofs], dtype=int)
    reactions.ravel()[supports] = effective.ravel()[supports]
    return reactions


def _triangle_projection(point, triangle):
    """Oriented plane gap and barycentric coordinates, or None off the face."""
    a, b, c = triangle
    first, second = b - a, c - a
    cross_value = np.cross(first, second)
    magnitude = np.linalg.norm(cross_value)
    if magnitude <= np.finfo(float).eps * max(np.linalg.norm(first) * np.linalg.norm(second), 1.):
        raise ValueError("contact master face is degenerate")
    normal = cross_value / magnitude
    gap = float((point - a) @ normal)
    projected = point - gap * normal
    gram = np.array([[first @ first, first @ second], [first @ second, second @ second]])
    coordinates = np.linalg.solve(gram, np.array([first @ (projected - a), second @ (projected - a)]))
    weights = np.r_[1 - coordinates.sum(), coordinates]
    tolerance = 2e-10
    if np.min(weights) < -tolerance or np.max(weights) > 1 + tolerance:
        return None
    weights = np.clip(weights, 0., 1.)
    weights /= weights.sum()
    return gap, weights, normal


def _surface_contact_response(points, current, contact, size):
    """Area-integrated slave-surface contact with a centroid spatial index."""
    slave_faces = np.asarray(contact["slaveFaces"], dtype=int)
    master_faces = np.asarray(contact["masterFaces"], dtype=int)
    if slave_faces.ndim != 2 or slave_faces.shape[1] != 3 or master_faces.ndim != 2 or master_faces.shape[1] != 3:
        raise ValueError("surface contact requires triangular slaveFaces and masterFaces")
    if not len(slave_faces) or not len(master_faces):
        raise ValueError("surface contact requires nonempty slaveFaces and masterFaces")
    master_triangles = current[master_faces]
    centroids = master_triangles.mean(axis=1)
    radii = np.max(np.linalg.norm(master_triangles - centroids[:, None], axis=2), axis=1)
    tree = cKDTree(centroids)
    maximum_radius = float(np.max(radii, initial=0.))
    search_distance = float(contact.get("searchDistance", np.inf))
    penalty = float(contact["penalty"])
    quadrature = np.array([[2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3]])
    force = np.zeros(size)
    rows, columns, values, active = [], [], [], []
    for slave_face in slave_faces:
        reference = points[slave_face]
        area = np.linalg.norm(np.cross(reference[1] - reference[0], reference[2] - reference[0])) / 2
        if area <= np.finfo(float).eps:
            raise ValueError("contact slave face is degenerate")
        for slave_weights in quadrature:
            point = slave_weights @ current[slave_face]
            distance, nearest = tree.query(point)
            candidate_ids = tree.query_ball_point(point, float(distance + radii[int(nearest)] + maximum_radius))
            matches = []
            for face_index in candidate_ids:
                master_face = master_faces[face_index]
                if np.intersect1d(slave_face, master_face).size:
                    continue
                projected = _triangle_projection(point, master_triangles[face_index])
                if projected is None:
                    continue
                gap, master_weights, normal = projected
                if gap >= 0 or -gap > search_distance:
                    continue
                matches.append((abs(gap), tuple(sorted(map(int, master_face))), int(face_index), gap, master_weights, normal))
            if not matches:
                continue
            _, _, face_index, gap, master_weights, normal = min(matches, key=lambda item: item[:3])
            master_face = master_faces[face_index]
            nodes = np.r_[slave_face, master_face]
            coefficients = np.r_[slave_weights, -master_weights]
            dofs = np.array([6 * node + axis for node in nodes for axis in range(3)])
            gradient = np.outer(coefficients, normal).ravel()
            integration_weight = area / 3
            np.add.at(force, dofs, penalty * gap * integration_weight * gradient)
            block = penalty * integration_weight * np.outer(gradient, gradient)
            rows.extend(np.repeat(dofs, len(dofs)))
            columns.extend(np.tile(dofs, len(dofs)))
            values.extend(block.ravel())
            active.append({
                "slaveFace": np.asarray(slave_face), "masterFace": np.asarray(master_face),
                "gap": gap, "normalForce": float(-penalty * gap * integration_weight),
            })
    tangent = sparse.csr_matrix((values, (rows, columns)), shape=(size, size))
    return force, tangent, active


def _point_contact_response(points, current, contact, size):
    """Legacy node-to-face contract retained for direct numerical fixtures."""
    force = np.zeros(size)
    rows, columns, values, active = [], [], [], []
    penalty = contact["penalty"]
    for slave in contact["slaves"]:
        for face in contact["faces"]:
            projected = _triangle_projection(current[slave], current[face])
            if projected is None:
                continue
            gap, weights, normal = projected
            if gap >= 0:
                continue
            nodes = np.r_[slave, face]
            coefficients = np.r_[1.0, -weights]
            dofs = np.array([6 * node + k for node in nodes for k in range(3)])
            gradient = np.outer(coefficients, normal).ravel()
            np.add.at(force, dofs, penalty * gap * gradient)
            block = penalty * np.outer(gradient, gradient)
            rows.extend(np.repeat(dofs, len(dofs)))
            columns.extend(np.tile(dofs, len(dofs)))
            values.extend(block.ravel())
            active.append({"slave": int(slave), "face": np.asarray(face), "gap": float(gap), "normalForce": float(-penalty * gap)})
            break
    tangent = sparse.csr_matrix((values, (rows, columns)), shape=(size, size))
    return force, tangent, active


def contact_response(points, displacement, contacts):
    """Frictionless penalty contact for legacy points or generated surfaces.

    Generated surfaces use three-point triangle quadrature and a pressure-like
    penalty per penetration, so uniform refinement does not multiply contact
    stiffness.  A centroid KD tree limits projection tests.  Each quadrature
    point deterministically owns one matching master triangle, including a
    shared edge, and therefore cannot double its reaction.
    """
    size = len(points) * 6
    force = np.zeros(size)
    rows, columns, values = [], [], []
    active = []
    current = points + displacement[:, :3]
    for contact in contacts:
        response = (
            _surface_contact_response(points, current, contact, size)
            if "slaveFaces" in contact else _point_contact_response(points, current, contact, size)
        )
        local_force, local_tangent, local_active = response
        force += local_force
        entries = local_tangent.tocoo()
        rows.extend(entries.row)
        columns.extend(entries.col)
        values.extend(entries.data)
        active.extend(local_active)
    tangent = sparse.csr_matrix((values, (rows, columns)), shape=(size, size))
    return force, tangent, active
