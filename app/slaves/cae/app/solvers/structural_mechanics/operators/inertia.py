"""Current mass, gyroscopic forces and their consistent derivatives."""

import numpy as np
from scipy import sparse

from ..beam import beam_cg_mass, beam_kinematics, physical_beam_mass
from ..corotation import _perturbed_configuration
from ..rotations import cross, skew, skew_many
from ..shells import shell4_director_mass
from .prepared import _beam_batch


_BEAM_SPIN_GENERATORS = np.asarray([np.kron(np.eye(4), skew(axis)) for axis in np.eye(3)])
_BEAM_SPIN_GENERATORS.flags.writeable = False


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
    for element, data in zip(model.elements, prepared.element_data):
        if element.kind == "beam2" and "physicalMass" not in data:
            data["physicalMass"] = physical_beam_mass(data["sectionM"])
    force = np.asarray(mass @ accel)
    # 요소별 블록을 triplet으로 모아 한 번에 CSR을 만듭니다. LIL에 작은
    # 블록을 반복 삽입하는 비용을 없애며 공유 절점의 값은 COO가 합산합니다.
    rows, columns, mass_values, configuration_values, velocity_values = [], [], [], [], []
    batch = _beam_batch(model, displacement, orientations, prepared) if not exact_tangent else None
    if batch is not None:
        centered = np.asarray([not np.any(data["physicalMass"][1]) for element, data in zip(model.elements, prepared.element_data) if element.kind == "beam2"])
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
    for element, data in zip(model.elements, prepared.element_data):
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
