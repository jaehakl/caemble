"""요소별 힘을 전역 평형식으로 모은다.

행렬의 각 작은 블록이 어느 절점의 어떤 자유도에 들어가는지 명시한다.
여기서는 시간이나 Catalog를 알지 못한다. 같은 조립을 정적/모달/과도에서
사용하며, 재료의 trial 이력은 반환만 하고 입력 이력은 수정하지 않는다.
"""

import numpy as np
from scipy import sparse

from .beam import (
    beam_batch_kinematics,
    beam_cg_mass,
    beam_deformation,
    beam_geometric_stiffness,
    beam_kinematics,
    beam_matrices,
    beam_response,
    physical_beam_mass,
    truss_response,
)
from .constraints import contact_response, spring_gradient, spring_gradient_tangent
from .continuum import (
    element_matrices,
    element_nonlinear_response,
    element_response,
    geometric_stiffness,
)
from .corotation import _perturbed_configuration, shell_deformation
from .rotations import cross, skew, skew_many
from .shells import (
    shell4_director_mass,
    shell4_geometric_stiffness,
    shell4_mass_moments,
    shell4_matrices,
    shell4_response,
)

# 공간 x/y/z 회전의 생성자입니다. 물성이나 해석 상태와 무관한 작은 상수입니다.
_BEAM_SPIN_GENERATORS = np.asarray([np.kron(np.eye(4), skew(axis)) for axis in np.eye(3)])
_BEAM_SPIN_GENERATORS.flags.writeable = False


def element_dofs(element):
    count = 6 if element.kind in ("beam2", "shell4") else 2 if element.kind in ("tri3", "quad4") else 3
    return (6 * element.nodes[:, None] + np.arange(count)).ravel()


def prepare_matrices(model):
    rows, columns, stiffness_values, mass_values, damping_values = [], [], [], [], []
    prepared = []
    for element in model.elements:
        points = model.points[element.nodes]
        material, section = element.material, element.section
        dofs = element_dofs(element)
        data = {"dofs": dofs}
        if element.kind == "beam2":
            length = np.linalg.norm(points[1] - points[0])
            local_K, local_M = beam_matrices(length, section["stiffness"], section["mass"])
            transform = np.kron(np.eye(4), section["frame"].T)
            K, M = transform.T @ local_K @ transform, transform.T @ local_M @ transform
            data.update(localK=local_K, localM=local_M, frame=section["frame"], length=length, sectionM=section["mass"])
            if np.any(section.get("damping", 0.0)):
                local_damping, _ = beam_matrices(length, section["damping"], np.zeros((6, 6)))
                data.update(localD=local_damping, D=transform.T @ local_damping @ transform)
        elif element.kind == "truss2":
            _, K, _ = truss_response(points, np.zeros((2, 3)), material["E"], section["area"])
            length = np.linalg.norm(points[1] - points[0])
            M = material["density"] * section["area"] * length / 6 * np.kron([[2, 1], [1, 2]], np.eye(3))
        elif element.kind == "shell4":
            K, M = shell4_matrices(points, section)
            normal, moments = shell4_mass_moments(points, section)
            data.update(normal=normal, massMoments=moments)
        else:
            coords = points[:, :2] if element.kind in ("tri3", "quad4") else points
            K, M = element_matrices(element.kind, coords, material["C"], material["density"], section.get("thickness", 1.0), section.get("plane", "stress"))
        data.update(K=K, M=M)
        prepared.append(data)
        rows.extend(np.repeat(dofs, len(dofs)))
        columns.extend(np.tile(dofs, len(dofs)))
        stiffness_values.extend(K.ravel())
        mass_values.extend(M.ravel())
        damping_values.extend(data.get("D", np.zeros_like(K)).ravel())
    shape = (model.size, model.size)
    stiffness = sparse.csr_matrix((stiffness_values, (rows, columns)), shape=shape)
    mass = sparse.csr_matrix((mass_values, (rows, columns)), shape=shape)
    damping = sparse.csr_matrix((damping_values, (rows, columns)), shape=shape).tolil()
    mass = mass.tolil()
    for node, weight, inertia in model.masses:
        indices = np.arange(6 * node, 6 * node + 6)
        block = np.zeros((6, 6))
        block[:3, :3] = np.eye(3) * weight
        block[3:, 3:] = inertia
        mass[np.ix_(indices, indices)] += block
    stiffness = stiffness.tolil()
    for a, b, ratio, spring, dashpot in model.springs:
        gradient = spring_gradient(model, np.tile(np.eye(3), (len(model.points), 1, 1)), a, b, ratio)
        dofs = np.flatnonzero(gradient)
        block = np.outer(gradient[dofs], gradient[dofs])
        stiffness[np.ix_(dofs, dofs)] += spring * block
        damping[np.ix_(dofs, dofs)] += dashpot * block
    beam_indices = [index for index, element in enumerate(model.elements) if element.kind == "beam2"]
    if len(beam_indices) > 1:
        # 해석 입력에서 한 번 준비하는 배치 배열입니다. checkpoint에는 넣지 않습니다.
        # 개별 prepared 요소도 보존하여 완전 접선/단일 요소 참조 경로를 유지합니다.
        batch = {"nodes": np.asarray([model.elements[index].nodes for index in beam_indices]), "frame": np.asarray([prepared[index]["frame"] for index in beam_indices])}
        batch["dofs"] = np.asarray([prepared[index]["dofs"] for index in beam_indices])
        batch["rows"] = np.repeat(batch["dofs"], 12, axis=1).ravel()
        batch["columns"] = np.tile(batch["dofs"], (1, 12)).ravel()
        for key in ("localK", "localM", "M", "localD", "D"):
            batch[key] = np.asarray([prepared[index].get(key, np.zeros((12, 12))) for index in beam_indices])
        for position, index in enumerate(beam_indices):
            prepared[index]["beamBatchIndex"] = position
        prepared[0]["beamBatch"] = batch
    return stiffness.tocsr(), mass.tocsr(), damping.tocsr(), prepared


def _beam_batch(model, displacement, orientations, prepared):
    """같은 보 묶음의 변형·frame·Jacobian을 세 물리 평가에서 공유합니다."""
    data = prepared[0].get("beamBatch") if prepared else None
    if data is None:
        return None
    nodes = data["nodes"]
    return data, beam_batch_kinematics(model.points[nodes], displacement[nodes, :3], orientations[nodes], data["frame"])


def structural_response(model, displacement, orientations, prepared, committed, geometric=False, approximate_tangent=False):
    force = np.zeros(model.size)
    rows, columns, values = [], [], []
    history, stresses = [], []
    energy = 0.0
    batch = _beam_batch(model, displacement, orientations, prepared) if geometric and approximate_tangent else None
    if batch is not None:
        batch_data, (deformations, frames, jacobians, _) = batch
        local_forces = (batch_data["localK"] @ deformations[..., None])[..., 0]
        batch_forces = (jacobians.transpose(0, 2, 1) @ local_forces[..., None])[..., 0]
        batch_tangents = jacobians.transpose(0, 2, 1) @ batch_data["localK"] @ jacobians
        batch_energy = .5 * np.einsum("ei,ei->e", deformations, local_forces)
        batch_local = (batch_forces.reshape(-1, 4, 3) @ frames).reshape(-1, 2, 6)
        np.add.at(force, batch_data["dofs"].ravel(), batch_forces.ravel())
        rows.append(batch_data["rows"])
        columns.append(batch_data["columns"])
        values.append(batch_tangents.ravel())
        energy = float(batch_energy.sum())
    for index, (element, data) in enumerate(zip(model.elements, prepared)):
        if batch is not None and element.kind == "beam2":
            local = batch_local[data["beamBatchIndex"]]
            history.append(None if committed is None else committed[index])
            stresses.append({"force": local[:, :3], "moment": local[:, 3:]})
            continue
        dofs = data["dofs"]
        values_u = displacement.ravel()[dofs]
        points = model.points[element.nodes]
        state = None if committed is None else committed[index]
        new_state, stress = state, None
        if geometric and element.kind == "beam2":
            internal, tangent, stored_energy = beam_response(points, displacement[element.nodes, :3], orientations[element.nodes], data["frame"], data["localK"], consistent_tangent=not approximate_tangent)
            current_frame = beam_deformation(points, displacement[element.nodes, :3], orientations[element.nodes], data["frame"])[1]
            local = (internal.reshape(4, 3) @ current_frame).reshape(2, 6)
            stress = {"force": local[:, :3], "moment": local[:, 3:]}
        elif geometric and element.kind == "truss2":
            internal, tangent, stored_energy = truss_response(points, displacement[element.nodes, :3], element.material["E"], element.section["area"])
        elif geometric and element.kind == "shell4":
            from .corotation import shell_corotational_response
            internal, tangent, stored_energy, stress = shell_corotational_response(points, displacement[element.nodes, :3], orientations[element.nodes], element.section)
        elif element.material["model"] == "mechanics.j2-plasticity@1":
            if geometric:
                raise ValueError("solid J2 uses small strain; finite-strain J2 is not implemented")
            internal, tangent, new_state, stress = element_nonlinear_response(element.kind, points, values_u, element.material, state)
            # 소성 소산과 탄성 에너지를 같게 취급하지 않습니다. 회복 가능한
            # 탄성변형률의 일만 strain energy로 집계합니다.
            stored_energy = 0.0
            from .continuum import integration_points
            for q, (_, B, weight, _) in enumerate(integration_points(element.kind, points)):
                elastic_strain = B @ values_u - new_state["plasticStrain"][q]
                stored_energy += 0.5 * elastic_strain @ stress[q] * weight
        else:
            if geometric and element.kind in ("tet4", "hex8", "tri3", "quad4"):
                raise ValueError("finite geometry is supported for truss, beam and shell blocks; continuum blocks use small strain")
            tangent = data["K"]
            internal = tangent @ values_u
            stored_energy = float(values_u @ internal / 2)
            if element.kind == "shell4":
                stress = shell4_response(points, values_u, element.section)
            elif element.kind == "beam2":
                local = np.kron(np.eye(4), data["frame"].T) @ internal
                stress = {"force": local.reshape(2, 6)[:, :3], "moment": local.reshape(2, 6)[:, 3:]}
            elif element.kind != "truss2":
                coords = points[:, :2] if element.kind in ("tri3", "quad4") else points
                stress = element_response(element.kind, coords, values_u, element.material["C"], element.section.get("thickness", 1), element.section.get("plane", "stress"))[1]
        np.add.at(force, dofs, internal)
        rows.append(np.repeat(dofs, len(dofs)))
        columns.append(np.tile(dofs, len(dofs)))
        values.append(tangent.ravel())
        energy += stored_energy
        history.append(new_state)
        stresses.append(stress)
    spring_geometric = sparse.csr_matrix((model.size, model.size))
    for a, b, ratio, stiffness, _ in model.springs:
        extension = displacement.ravel()[a] - (ratio * displacement.ravel()[b] if b >= 0 else 0.)
        gradient = spring_gradient(model, orientations, a, b, ratio)
        force += stiffness * extension * gradient
        dofs = np.flatnonzero(gradient)
        rows.append(np.repeat(dofs, len(dofs)))
        columns.append(np.tile(dofs, len(dofs)))
        values.append((stiffness * np.outer(gradient[dofs], gradient[dofs])).ravel())
        if geometric:
            spring_geometric += stiffness * extension * spring_gradient_tangent(model, orientations, a, b, ratio)
        energy += stiffness * extension**2 / 2
    tangent = sparse.csr_matrix((np.concatenate(values), (np.concatenate(rows), np.concatenate(columns))), shape=(model.size, model.size)) + spring_geometric if rows else spring_geometric
    if model.contacts:
        contact_force, contact_tangent, active_contacts = contact_response(model.points, displacement, model.contacts)
        force += contact_force
        tangent += contact_tangent
        energy += sum(-0.5 * item["gap"] * item["normalForce"] for item in active_contacts)
    return force, tangent.tocsr(), history, stresses, float(energy)


def strain_rate_damping(model, displacement, orientations, prepared, coefficient, geometric=False):
    """변형률 속도에 비례하는 감쇠 C(q)=beta J(q).T K_local J(q).

    beta의 단위는 s다. 국소 변형률이 변할 때만 에너지를 소산하므로 회전 중인
    무변형 블레이드를 가짜 브레이크로 멈추지 않는다. 기준 전역 K에 공간 속도를
    바로 곱하는 Rayleigh 감쇠는 큰 회전에서 이 객관성을 만족하지 않는다.
    질량 비례 감쇠와 명시적 조인트 댐퍼는 호출자가 별도로 더한다.
    """
    rows, columns, values = [], [], []
    joint_dampers = geometric and any(dashpot for _, _, _, _, dashpot in model.springs)
    if coefficient == 0 and not joint_dampers and (not geometric or not any("localD" in data for data in prepared)):
        return sparse.csr_matrix((model.size, model.size))
    batch = _beam_batch(model, displacement, orientations, prepared) if geometric else None
    if batch is not None:
        batch_data, (_, _, jacobians, _) = batch
        batch_damping = jacobians.transpose(0, 2, 1) @ (coefficient * batch_data["localK"] + batch_data["localD"]) @ jacobians - batch_data["D"]
        rows.append(batch_data["rows"])
        columns.append(batch_data["columns"])
        values.append(batch_damping.ravel())
    for element, data in zip(model.elements, prepared):
        if batch is not None and element.kind == "beam2":
            continue
        dofs = data["dofs"]
        nodes, points = element.nodes, model.points[element.nodes]
        if coefficient == 0 and "localD" not in data:
            continue
        if not geometric:
            block = data["K"]
        elif element.kind == "beam2":
            # 기준 단면 감쇠는 prepare_matrices의 C에 이미 있다. 현재 방향과의
            # 차이만 더해 이중 조립을 피한다. beta*K도 같은 객관적 경로다.
            jacobian = beam_kinematics(points, displacement[nodes, :3], orientations[nodes], data["frame"])[2]
            block = jacobian.T @ (coefficient * data["localK"] + data.get("localD", 0.0)) @ jacobian - data.get("D", 0.0)
        elif element.kind == "truss2":
            direction = points[1] + displacement[nodes[1], :3] - points[0] - displacement[nodes[0], :3]
            direction /= np.linalg.norm(direction)
            gradient = np.r_[-direction, direction]
            block = element.material["E"] * element.section["area"] / np.linalg.norm(points[1] - points[0]) * np.outer(gradient, gradient)
        elif element.kind == "shell4":
            jacobian = np.empty((24, 24))
            length = np.max(np.linalg.norm(points - points.mean(axis=0), axis=1))
            for column in range(24):
                step = 2e-6 * (length if column % 6 < 3 else 1.)
                plus = _perturbed_configuration(displacement[nodes, :3], orientations[nodes], column, step)
                minus = _perturbed_configuration(displacement[nodes, :3], orientations[nodes], column, -step)
                jacobian[:, column] = (shell_deformation(points, *plus) - shell_deformation(points, *minus)) / (2 * step)
            block = jacobian.T @ data["K"] @ jacobian
        else:
            block = data["K"]
        rows.append(np.repeat(dofs, len(dofs)))
        columns.append(np.tile(dofs, len(dofs)))
        values.append((block if geometric and element.kind == "beam2" else coefficient * block).ravel())
    for a, b, ratio, stiffness, dashpot in model.springs:
        gradient = spring_gradient(model, orientations, a, b, ratio)
        reference = spring_gradient(model, np.tile(np.eye(3), (len(model.points), 1, 1)), a, b, ratio)
        dofs = np.union1d(np.flatnonzero(gradient), np.flatnonzero(reference))
        block = coefficient * stiffness * np.outer(gradient[dofs], gradient[dofs])
        if geometric:
            block += dashpot * (np.outer(gradient[dofs], gradient[dofs]) - np.outer(reference[dofs], reference[dofs]))
        rows.append(np.repeat(dofs, len(dofs)))
        columns.append(np.tile(dofs, len(dofs)))
        values.append(block.ravel())
    if not rows:
        return sparse.csr_matrix((model.size, model.size))
    return sparse.csr_matrix((np.concatenate(values), (np.concatenate(rows), np.concatenate(columns))), shape=(model.size, model.size))


def geometric_matrix(model, displacement, prepared):
    rows, columns, values = [], [], []
    for element, data in zip(model.elements, prepared):
        dofs = data["dofs"]
        u = displacement.ravel()[dofs]
        points = model.points[element.nodes]
        if element.kind == "beam2":
            transform = np.kron(np.eye(4), data["frame"].T)
            end_force = data["localK"] @ (transform @ u)
            block = transform.T @ beam_geometric_stiffness(data["length"], end_force[6]) @ transform
        elif element.kind == "truss2":
            length = np.linalg.norm(points[1] - points[0])
            direction = (points[1] - points[0]) / length
            tension = element.material["E"] * element.section["area"] / length * direction @ (u[3:] - u[:3])
            tensor = tension / length * (np.eye(3) - np.outer(direction, direction))
            block = np.block([[tensor, -tensor], [-tensor, tensor]])
        elif element.kind == "shell4":
            response = shell4_response(points, u, element.section)
            block = shell4_geometric_stiffness(points, response["force"])
        else:
            coords = points[:, :2] if element.kind in ("tri3", "quad4") else points
            stress = element_response(element.kind, coords, u, element.material["C"], element.section.get("thickness", 1), element.section.get("plane", "stress"))[1]
            block = geometric_stiffness(element.kind, coords, stress, element.section.get("thickness", 1), element.section.get("plane", "stress"))
        rows.extend(np.repeat(dofs, len(dofs)))
        columns.extend(np.tile(dofs, len(dofs)))
        values.extend(block.ravel())
    return sparse.csr_matrix((values, (rows, columns)), shape=(model.size, model.size))


def _moving_mass(kind, points, translations, orientations, data):
    """강체 회전과 함께 회전하는 단면 관성의 현재 공간 성분입니다."""
    if kind == "beam2":
        if np.any(data["physicalMass"][1]):
            return beam_cg_mass(points, translations, orientations, data["frame"], data["physicalMass"])[0]
        frame = beam_kinematics(points, translations, orientations, data["frame"])[1]
        transform = np.kron(np.eye(4), frame)
        return transform @ data["localM"] @ transform.T
    return shell4_director_mass(data["normal"], data["massMoments"], orientations)[0]


def _element_inertia(kind, points, translations, orientations, velocity, acceleration, data, need_mass_derivatives=False):
    """운동에너지 T=1/2 v.T M(q) v에서 관성력과 속도 미분을 얻습니다.

    공간 회전의 가상변위는 일반 벡터 좌표와 다릅니다. 따라서 회전 행에는
    -omega×각운동량 항이 추가됩니다. 이 항을 빼먹으면 단순 강체 관성의
    알려진 식 I*alpha + omega×(I*omega)조차 맞지 않습니다.
    """
    speed, accel = velocity.reshape(-1), acceleration.reshape(-1)
    if kind == "shell4":
        mass, derivatives = shell4_director_mass(
            data["normal"], data["massMoments"], orientations,
            with_derivatives=np.any(speed) or need_mass_derivatives,
        )
    elif np.any(data["physicalMass"][1]):
        mass, derivatives = beam_cg_mass(
            points, translations, orientations, data["frame"], data["physicalMass"],
            with_derivatives=np.any(speed) or need_mass_derivatives,
        )
    else:
        mass = _moving_mass(kind, points, translations, orientations, data)
        derivatives = np.zeros((len(speed), len(speed), len(speed)))
        if np.any(speed) or need_mass_derivatives:
            frame_spin = beam_kinematics(points, translations, orientations, data["frame"])[3]
            # 모든 절점 자유도에 대해 큰 회전 행렬을 새로 만들 필요는 없습니다.
            # 공간의 x/y/z 세 회전 미분을 구한 뒤 frame spin으로 조합합니다.
            axis_derivatives = _BEAM_SPIN_GENERATORS @ mass - mass @ _BEAM_SPIN_GENERATORS
            derivatives = np.einsum("ai,ajk->ijk", frame_spin, axis_derivatives)
    rate = np.einsum("i,ijk->jk", speed, derivatives)
    derivative_speed = np.einsum("ijk,k->ij", derivatives, speed)
    momentum = mass @ speed
    gyroscopic = rate @ speed - .5 * derivative_speed @ speed
    velocity_tangent = derivative_speed.T + rate - derivative_speed
    for node in range(len(points)):
        rows = np.arange(6 * node + 3, 6 * node + 6)
        omega = velocity[node, 3:]
        gyroscopic[rows] -= cross(omega, momentum[rows])
        velocity_tangent[rows] -= skew(omega) @ mass[rows]
        velocity_tangent[np.ix_(rows, rows)] += skew(momentum[rows])
    return mass @ accel + gyroscopic, mass, velocity_tangent, float(speed @ momentum / 2), derivatives


def _beam_inertia_batch(batch, velocity, acceleration):
    """운동에너지에서 유도한 기존 보 관성식을 element 축으로 묶습니다.

    회전 질량, dM/dq, gyro 및 속도 접선의 항은 단일 요소식과 같습니다.
    오직 Python 요소 반복을 NumPy 배치 행렬곱으로 바꿉니다.
    """
    data, (_, frames, _, frame_spin) = batch
    count = len(frames)
    transform = np.einsum("ij,eab->eiajb", np.eye(4), frames).reshape(count, 12, 12)
    mass = transform @ data["localM"] @ transform.transpose(0, 2, 1)
    axis_derivatives = _BEAM_SPIN_GENERATORS[None] @ mass[:, None] - mass[:, None] @ _BEAM_SPIN_GENERATORS[None]
    # e=요소, a=공간 회전축 3개, i/j=요소 자유도 12개입니다.
    # dM/dq_i = sum_a (dM/dtheta_a) * frame_spin[a,i]입니다.
    # 12×12×12 배열을 먼저 만들지 않고, 최종적으로 필요한 벡터와
    # 곱한 뒤 세 회전축을 합산합니다. 같은 연쇄미분을 적은 메모리로 풉니다.
    speed, accel = velocity[data["nodes"]].reshape(count, 12), acceleration[data["nodes"]].reshape(count, 12)
    angular_rate = (frame_spin @ speed[..., None])[..., 0]
    rate = np.einsum("ea,eaij->eij", angular_rate, axis_derivatives)
    derivative_speed = frame_spin.transpose(0, 2, 1) @ (axis_derivatives @ speed[:, None, :, None])[..., 0]
    configuration_tangent = (axis_derivatives @ accel[:, None, :, None])[..., 0].transpose(0, 2, 1) @ frame_spin
    momentum = (mass @ speed[..., None])[..., 0]
    gyroscopic = ((rate - .5 * derivative_speed) @ speed[..., None])[..., 0]
    velocity_tangent = derivative_speed.transpose(0, 2, 1) + rate - derivative_speed
    for node in range(2):
        rows = slice(6 * node + 3, 6 * node + 6)
        gyroscopic[:, rows] -= np.cross(speed[:, rows], momentum[:, rows])
        velocity_tangent[:, rows, :] -= skew_many(speed[:, rows]) @ mass[:, rows, :]
        velocity_tangent[:, rows, rows] += skew_many(momentum[:, rows])
    force = (mass @ accel[..., None])[..., 0] + gyroscopic
    return force, mass, velocity_tangent, configuration_tangent


def inertial_response(model, displacement, orientations, velocity, acceleration, prepared, mass, geometric=False, derivatives=False, exact_tangent=False):
    """(관성력, 현재 M, 위치 접선, 속도 접선, 운동에너지)를 조립합니다.

    선형 해석에서는 상수 M*a입니다. 유한회전에서는 보/쉘의 단면 질량과
    lump의 관성을 현재 방향으로 회전시키고 convective/gyroscopic 항을
    포함합니다. modified Newton은 분포 관성의 위치 접선에서 dM/dq*a만
    유지하며 gyro의 위치 미분은 생략합니다. 물리적 내력은 항상 완전하게
    다시 계산합니다. 수렴이 느려지면 exact_tangent로 전체 위치 미분을
    계산합니다. 속도 미분과 lump 관성 접선은 항상 정확합니다.
    입력 상태는 읽기만 하며 캐시에 결과 정합성을 의존하지
    않습니다. 솔리드/트러스의 Cartesian 병진 질량은 회전할 필요가 없습니다.
    """
    zero = sparse.csr_matrix((model.size, model.size))
    speed, accel = velocity.ravel(), acceleration.ravel()
    if not geometric:
        return mass @ accel, mass, zero, zero, float(speed @ (mass @ speed) / 2)
    # 직접 수치 API로 만든 모델도 실제 유한회전 관성 경로에서 검증한다.
    # 선형 해석은 이 분해가 필요 없으므로 임의의 SPD 단면 M을 유지한다.
    # prepared의 수학 데이터만 재사용하며 checkpoint/재료 이력은 바꾸지 않는다.
    for element, data in zip(model.elements, prepared):
        if element.kind == "beam2" and "physicalMass" not in data:
            data["physicalMass"] = physical_beam_mass(data["sectionM"])
    force = np.asarray(mass @ accel)
    # 요소별 블록을 triplet으로 모아 한 번에 CSR을 만듭니다. LIL에 작은
    # 블록을 반복 삽입하는 비용을 없애며 공유 절점의 값은 COO가 합산합니다.
    rows, columns, mass_values, configuration_values, velocity_values = [], [], [], [], []
    batch = _beam_batch(model, displacement, orientations, prepared) if not exact_tangent else None
    if batch is not None:
        centered = np.asarray([not np.any(data["physicalMass"][1]) for element, data in zip(model.elements, prepared) if element.kind == "beam2"])
        if not np.all(centered):
            # 편심이 있는 보만 아래의 명시적인 단일 요소 식으로 계산한다.
            # h=0인 원래 모델은 이 분기를 전혀 거치지 않아 연산 순서도 같다.
            if np.any(centered):
                data, kinematics = batch
                data = {name: values[centered] for name, values in data.items() if name not in ("rows", "columns")}
                data["rows"] = np.repeat(data["dofs"], 12, axis=1).ravel()
                data["columns"] = np.tile(data["dofs"], (1, 12)).ravel()
                batch = data, tuple(values[centered] for values in kinematics)
            else:
                batch = None
    batch_values = None if batch is None else _beam_inertia_batch(batch, velocity, acceleration)
    if batch_values is not None:
        data = batch[0]
        internal, moving, damping, configuration_tangent = batch_values
        accel_batch = acceleration[data["nodes"]].reshape(-1, 12)
        correction = internal - (data["M"] @ accel_batch[..., None])[..., 0]
        np.add.at(force, data["dofs"].ravel(), correction.ravel())
        rows.append(data["rows"])
        columns.append(data["columns"])
        mass_values.append((moving - data["M"]).ravel())
        if derivatives:
            velocity_values.append(damping.ravel())
            configuration_values.append(configuration_tangent.ravel())
    for element, data in zip(model.elements, prepared):
        if element.kind not in ("beam2", "shell4"):
            continue
        if element.kind == "beam2" and batch_values is not None and not np.any(data["physicalMass"][1]):
            continue
        nodes, dofs = element.nodes, data["dofs"]
        points = model.points[nodes]
        translations, rotations = displacement[nodes, :3], orientations[nodes]
        v, a = velocity[nodes], acceleration[nodes]
        internal, moving, damping, _, mass_derivatives = _element_inertia(element.kind, points, translations, rotations, v, a, data, derivatives)
        np.add.at(force, dofs, internal - data["M"] @ a.ravel())
        rows.append(np.repeat(dofs, len(dofs)))
        columns.append(np.tile(dofs, len(dofs)))
        mass_values.append((moving - data["M"]).ravel())
        if derivatives:
            velocity_values.append(damping.ravel())
            derivative = np.einsum("ijk,k->ji", mass_derivatives, a.ravel())
            if exact_tangent:
                length = np.max(np.linalg.norm(points - points.mean(axis=0), axis=1))
                for column in range(len(dofs)):
                    step = 2e-5 * (length if column % 6 < 3 else 1.)
                    plus = _perturbed_configuration(translations, rotations, column, step)
                    minus = _perturbed_configuration(translations, rotations, column, -step)
                    fp = _element_inertia(element.kind, points, *plus, v, a, data)[0]
                    fm = _element_inertia(element.kind, points, *minus, v, a, data)[0]
                    derivative[:, column] = (fp - fm) / (2 * step)
            configuration_values.append(derivative.ravel())
    for node, _, reference_inertia in model.masses:
        dofs = np.arange(6 * node + 3, 6 * node + 6)
        inertia = orientations[node] @ reference_inertia @ orientations[node].T
        omega, alpha = velocity[node, 3:], acceleration[node, 3:]
        momentum = inertia @ omega
        force[dofs] += (inertia - reference_inertia) @ alpha + cross(omega, momentum)
        rows.append(np.repeat(dofs, 3))
        columns.append(np.tile(dofs, 3))
        mass_values.append((inertia - reference_inertia).ravel())
        if derivatives:
            velocity_values.append((skew(omega) @ inertia - skew(momentum)).ravel())
            block = np.empty((3, 3))
            for axis in range(3):
                generator = skew(np.eye(3)[axis])
                change = generator @ inertia - inertia @ generator
                block[:, axis] = change @ alpha + cross(omega, change @ omega)
            configuration_values.append(block.ravel())
    if not rows:
        return force, mass, zero, zero, float(speed @ (mass @ speed) / 2)
    coordinates = np.concatenate(rows), np.concatenate(columns)
    current_mass = mass + sparse.csr_matrix((np.concatenate(mass_values), coordinates), shape=mass.shape)
    configuration_tangent = sparse.csr_matrix((np.concatenate(configuration_values), coordinates), shape=mass.shape) if derivatives else zero
    velocity_tangent = sparse.csr_matrix((np.concatenate(velocity_values), coordinates), shape=mass.shape) if derivatives else zero
    return force, current_mass, configuration_tangent, velocity_tangent, float(speed @ (current_mass @ speed) / 2)
