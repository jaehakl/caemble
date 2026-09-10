"""공간 보와 트러스: 국소 단면의 변형을 힘으로 바꾸는 과정.

보의 국소 x는 길이, y와 z는 단면 방향이다. 단면 변형 순서는
[늘어남, y전단, z전단, 비틀림, y곡률, z곡률]이다. 각 곡률은 1/m,
앞 세 변형률은 무차원이다. 이 순서의 6×6 단면 행렬은 단위가 혼합되므로
공개 입력에서는 힘/곡률/모멘트 블록으로 나눈다.

작은 변형률이지만 큰 강체 회전은 허용한다. 매 평가에서 보와 함께 움직이는
좌표계를 만든 뒤, 그 좌표계에 대한 상대 회전만 탄성 변형으로 사용한다.
회전을 벡터 덧셈으로 누적하지 않고 회전행렬의 곱으로 합성하는 이유다.
"""

from functools import lru_cache

import numpy as np

from .rotations import (
    cross,
    rotation_exp,
    rotation_log,
    rotation_log_many,
    skew,
    skew_many,
)


def beam_frame(points: np.ndarray, orientation: np.ndarray) -> np.ndarray:
    """단면 y 방향을 보 축에 수직으로 투영한다. 임의 축을 조용히 선택하지 않는다."""
    delta = points[1] - points[0]
    length = np.linalg.norm(delta)
    if length <= 0:
        raise ValueError("beam/truss element has zero length")
    x = delta / length
    y = np.asarray(orientation, dtype=float) - x * (x @ orientation)
    if np.linalg.norm(y) < 1e-12:
        raise ValueError("beam orientation is parallel to its axis")
    y /= np.linalg.norm(y)
    return np.column_stack((x, y, cross(x, y)))


def isotropic_beam_section(E: float, nu: float, density: float, area: float, inertias: np.ndarray, shear_areas: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """단면 형상(A,J,Iy,Iz)과 재료(E,nu,rho)를 여기서 처음 결합한다."""
    G = E / (2 * (1 + nu))
    J, Iy, Iz = inertias
    if min(E, density, area, J, Iy, Iz, *shear_areas) <= 0:
        raise ValueError("beam material, area and section inertias must be positive")
    stiffness = np.diag([E * area, G * shear_areas[0], G * shear_areas[1], G * J, E * Iy, E * Iz])
    mass = np.diag([density * area] * 3 + [density * (Iy + Iz), density * Iy, density * Iz])
    return stiffness, mass


def physical_beam_mass(section_mass: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """유한회전에 필요한 단면 질량 m[kg/m], CG e[m], 중앙 관성 Jc[kg*m].

    실제 질량의 6×6 행렬은 [[mI,-skew(h)],[skew(h),J]]이며 h=m*e다.
    임의 SPD 행렬이 이 물리적 구조를 만족하는 것은 아니다. 선형 문제의
    일반화 행렬은 그대로 허용하지만, 유한회전에서 이를 몰래 투영하지 않는다.
    입력 배열은 변경하지 않고 좌표 변환의 부동소수점 오차만 허용한다.
    """
    matrix = np.asarray(section_mass, dtype=float)
    if matrix.shape != (6, 6) or not np.all(np.isfinite(matrix)):
        raise ValueError("finite-rotation beam mass must be a finite 6 by 6 matrix")
    m = float(np.trace(matrix[:3, :3]) / 3)
    if m <= 0 or not np.allclose(matrix[:3, :3], m * np.eye(3), rtol=0, atol=1e-12 * m):
        raise ValueError("finite-rotation beam mass translation must equal positive m times identity")
    coupling = matrix[:3, 3:]
    coupling_scale = np.max(np.abs(coupling))
    if not np.allclose(coupling, -coupling.T, rtol=0, atol=1e-12 * coupling_scale) or not np.allclose(matrix[3:, :3], coupling.T, rtol=0, atol=1e-12 * coupling_scale):
        raise ValueError("finite-rotation beam mass coupling must be skew-symmetric with transpose lower block")
    h = np.array([coupling[1, 2] - coupling[2, 1], coupling[2, 0] - coupling[0, 2], coupling[0, 1] - coupling[1, 0]]) / 2
    center = h / m
    inertia = matrix[3:, 3:]
    if not np.allclose(inertia, inertia.T, rtol=0, atol=1e-12 * np.max(np.abs(inertia))):
        raise ValueError("finite-rotation beam rotary mass must be symmetric")
    central = (inertia + inertia.T) / 2 - m * (np.dot(center, center) * np.eye(3) - np.outer(center, center))
    if np.linalg.eigvalsh(central).min() <= 0:
        raise ValueError("finite-rotation beam central inertia must be positive definite")
    # 실제 질량분포의 중앙 2차 모멘트 S도 음수가 될 수 없다.
    # 이 조건은 관성의 삼각부등식이며, 평면 단면의 고유값 0은 허용한다.
    second_moment = .5 * np.trace(central) * np.eye(3) - central
    if np.linalg.eigvalsh(second_moment).min() < -1e-12 * np.max(np.abs(central)):
        raise ValueError("finite-rotation beam central inertia violates physical triangle inequalities")
    return m, center, central


def beam_cg_mass(points, translations, rotations, reference_frame, properties, with_derivatives=False):
    """절점 CG 운동과 corotational 중앙 관성에서 M, dM/dq를 얻는다.

    b_i=R_i*F0*e, w_i=v_i+omega_i×b_i가 실제 절점 CG 속도다.
    T=1/2 ∫[m|ΣNi*w_i|²+(ΣNi*omega_i).T*(F*Jc*F.T)*(ΣNi*omega_i)]dx.
    CG/평행축 항은 절점 자세를 따른다. 중앙 회전관성은 작은 상대변형을
    가정하는 기존 공통 corotational frame 근사이며, nodal director를
    보간한 모든 단면 물질점의 운동에너지와 같다고 주장하지 않는다.
    """
    m, center, central = properties
    _, frame, _, frame_spin = beam_kinematics(points, translations, rotations, reference_frame)
    arms = rotations @ (reference_frame @ center)
    velocity_maps = np.concatenate((np.broadcast_to(np.eye(3), (2, 3, 3)), -skew_many(arms)), axis=2)
    central_world = frame @ central @ frame.T
    length = np.linalg.norm(points[1] - points[0])
    weights = length / 6 * np.array([[2., 1.], [1., 2.]])
    mass = np.zeros((12, 12))
    derivatives = np.zeros((12, 12, 12))
    if with_derivatives:
        generators = skew_many(np.eye(3))
        central_axes = generators @ central_world - central_world @ generators
        central_derivatives = np.einsum("ai,ajk->ijk", frame_spin, central_axes)
        arm_derivatives = np.zeros((2, 3, 3, 6))
        for node in range(2):
            for axis in range(3):
                arm_derivatives[node, axis, :, 3:] = -skew(cross(np.eye(3)[axis], arms[node]))
    for i in range(2):
        rows, rotation_rows = slice(6*i, 6*i+6), slice(6*i+3, 6*i+6)
        for j in range(2):
            columns, rotation_columns = slice(6*j, 6*j+6), slice(6*j+3, 6*j+6)
            weight = weights[i, j]
            mass[rows, columns] = weight * m * velocity_maps[i].T @ velocity_maps[j]
            mass[rotation_rows, rotation_columns] += weight * central_world
            if with_derivatives:
                derivatives[:, rotation_rows, rotation_columns] += weight * central_derivatives
                for axis in range(3):
                    derivatives[6*i+3+axis, rows, columns] += weight * m * arm_derivatives[i, axis].T @ velocity_maps[j]
                    derivatives[6*j+3+axis, rows, columns] += weight * m * velocity_maps[i].T @ arm_derivatives[j, axis]
    return mass, derivatives


def beam_matrices(length: float, section_stiffness: np.ndarray, section_mass: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """2절점 Timoshenko 보를 적분한다.

    전단 변형만 중점에서 평가하는 assumed-strain 방식은 가느다란 보가
    인위적으로 딱딱해지는 전단 locking을 막는다. 굽힘/축력과 모든 단면
    결합항은 그대로 적분한다. 질량은 두 Gauss 점의 일관 질량이다.
    한 요소의 굽힘 정확도에는 한계가 있으므로 보 분할 수렴을 검증한다.
    """
    stiffness = np.zeros((12, 12))
    mass = np.zeros((12, 12))
    derivative = np.array([-1.0, 1.0]) / length
    for xi in (-1 / np.sqrt(3), 1 / np.sqrt(3)):
        shape = np.array([(1 - xi) / 2, (1 + xi) / 2])
        B = np.zeros((6, 12))
        N = np.zeros((6, 12))
        for node in range(2):
            start = 6 * node
            B[:3, start:start + 3] = np.eye(3) * derivative[node]
            B[3:, start + 3:start + 6] = np.eye(3) * derivative[node]
            B[1, start + 5] = -0.5
            B[2, start + 4] = 0.5
            N[:, start:start + 6] = np.eye(6) * shape[node]
        stiffness += B.T @ section_stiffness @ B * length / 2
        mass += N.T @ section_mass @ N * length / 2
    return stiffness, mass


def _beam_deformation(points: np.ndarray, translations: np.ndarray, rotations: np.ndarray, reference_frame: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """축 늘어남과 움직이는 보 좌표계에 대한 두 절점의 상대회전입니다."""
    current = points + translations
    # 단면 y의 평균을 이용하여 chord 주위의 임의적인 좌표계 회전을 막는다.
    direction = (rotations[0] + rotations[1]) @ reference_frame[:, 1]
    frame = beam_frame(current, direction)
    length = np.linalg.norm(points[1] - points[0])
    deformation = np.zeros(12)
    deformation[6] = np.linalg.norm(current[1] - current[0]) - length
    deformation[3:6] = rotation_log(frame.T @ rotations[0] @ reference_frame)
    deformation[9:12] = rotation_log(frame.T @ rotations[1] @ reference_frame)
    return deformation, frame


def _beam_kinematics(points, translations, rotations, reference_frame):
    """국소 변형, 현재 frame, 변형 Jacobian, frame spin Jacobian입니다."""
    deformation, frame = _beam_deformation(points, translations, rotations, reference_frame)
    x, y, z = frame.T
    chord = points[1] + translations[1] - points[0] - translations[0]
    direction = (rotations[0] + rotations[1]) @ reference_frame[:, 1]
    chord_derivative, direction_derivative = np.zeros((3, 12)), np.zeros((3, 12))
    chord_derivative[:, :3], chord_derivative[:, 6:9] = -np.eye(3), np.eye(3)
    direction_derivative[:, 3:6] = -skew(rotations[0] @ reference_frame[:, 1])
    direction_derivative[:, 9:12] = -skew(rotations[1] @ reference_frame[:, 1])
    # 단위벡터 n=a/|a|의 미분은 (I-n*n.T)/|a|입니다. 이를 chord와
    # 투영 단면축에 차례로 적용하면 움직이는 좌표계의 미분을 직접 얻습니다.
    dx = (np.eye(3) - np.outer(x, x)) @ chord_derivative / np.linalg.norm(chord)
    projected_derivative = direction_derivative - (x @ direction) * dx - np.outer(x, direction @ dx + x @ direction_derivative)
    dy = (np.eye(3) - np.outer(y, y)) @ projected_derivative / np.linalg.norm(direction - x * (x @ direction))
    dz = -skew(y) @ dx + skew(x) @ dy
    frame_spin = .5 * (skew(x) @ dx + skew(y) @ dy + skew(z) @ dz)
    jacobian = np.zeros((12, 12))
    jacobian[6] = x @ chord_derivative
    for node in range(2):
        rows = slice(6 * node + 3, 6 * node + 6)
        relative = deformation[rows]
        angle = np.linalg.norm(relative)
        cross = skew(relative)
        # log(exp(delta)*R)의 미분입니다. 작은 각도에서 1/angle²끼리
        # 빼면 자릿수를 잃으므로 급수를 사용합니다.
        coefficient = 1 / 12 + angle**2 / 720 + angle**4 / 30240 if angle < 1e-4 else (1 - .5 * angle / np.tan(angle / 2)) / angle**2
        log_derivative = np.eye(3) - .5 * cross + coefficient * cross @ cross
        nodal_spin = np.zeros((3, 12)); nodal_spin[:, rows] = np.eye(3)
        jacobian[rows] = log_derivative @ frame.T @ (nodal_spin - frame_spin)
    return deformation, frame, jacobian, frame_spin


@lru_cache(maxsize=256)
def _cached_beam_kinematics(points, translations, rotations, reference_frame):
    """동일 자세의 내력·감쇠·관성 평가가 쓰는 순수 수학 결과를 재사용합니다.

    키에는 네 입력 배열의 float64 값 전체가 들어갑니다. 시간이 같다는 이유로
    trial을 재사용하거나 checkpoint 상태에 의존하지 않습니다. 배열을 불변으로
    반환하며 256개만 보관하므로 긴 해석에서 메모리가 계속 늘지 않습니다.
    """
    result = _beam_kinematics(np.frombuffer(points).reshape(2, 3), np.frombuffer(translations).reshape(2, 3), np.frombuffer(rotations).reshape(2, 3, 3), np.frombuffer(reference_frame).reshape(3, 3))
    for value in result:
        value.flags.writeable = False
    return result


def beam_kinematics(points, translations, rotations, reference_frame):
    """국소 변형, frame, 변형 Jacobian, frame spin의 불변 배열입니다."""
    return _cached_beam_kinematics(*(np.asarray(value, dtype=np.float64).tobytes() for value in (points, translations, rotations, reference_frame)))


def beam_deformation(points, translations, rotations, reference_frame):
    """내력 평가와 같은 자세의 국소 변형 및 frame을 사용합니다."""
    deformation, frame, _, _ = beam_kinematics(points, translations, rotations, reference_frame)
    return deformation, frame


@lru_cache(maxsize=4)
def _cached_beam_batch(count, points, translations, rotations, reference_frames):
    """보 여러 개에 동일한 기하식을 적용합니다. 요소끼리 물리를 섞지 않습니다.

    앞의 단일 요소 함수와 식은 같습니다. 맨 앞의 element 축만 추가하여
    NumPy가 작은 행렬 연산을 묶어서 처리하게 합니다. 입력 전체를 키로 쓰는
    4개짜리 불변 캐시이므로 서로 다른 연성 trial을 혼동하지 않습니다.
    """
    points = np.frombuffer(points).reshape(count, 2, 3)
    translations = np.frombuffer(translations).reshape(count, 2, 3)
    rotations = np.frombuffer(rotations).reshape(count, 2, 3, 3)
    reference_frames = np.frombuffer(reference_frames).reshape(count, 3, 3)
    current = points + translations
    chord = current[:, 1] - current[:, 0]
    length = np.linalg.norm(chord, axis=1)
    if np.any(length <= 0):
        raise ValueError("beam/truss element has zero length")
    x = chord / length[:, None]
    section_axes = (rotations @ reference_frames[:, None, :, 1, None])[..., 0]
    direction = section_axes.sum(axis=1)
    axial_direction = np.einsum("ei,ei->e", x, direction)
    projected = direction - x * axial_direction[:, None]
    projected_length = np.linalg.norm(projected, axis=1)
    if np.any(projected_length < 1e-12):
        raise ValueError("beam orientation is parallel to its axis")
    y = projected / projected_length[:, None]
    z = np.cross(x, y)
    frames = np.stack((x, y, z), axis=2)
    inverse_frames = frames.transpose(0, 2, 1)
    relative = rotation_log_many(inverse_frames[:, None] @ rotations @ reference_frames[:, None])
    deformation = np.zeros((count, 12))
    deformation[:, 6] = length - np.linalg.norm(points[:, 1] - points[:, 0], axis=1)
    deformation[:, 3:6], deformation[:, 9:12] = relative[:, 0], relative[:, 1]
    chord_derivative = np.zeros((3, 12))
    chord_derivative[:, :3], chord_derivative[:, 6:9] = -np.eye(3), np.eye(3)
    direction_derivative = np.zeros((count, 3, 12))
    direction_derivative[:, :, 3:6] = -skew_many(section_axes[:, 0])
    direction_derivative[:, :, 9:12] = -skew_many(section_axes[:, 1])
    dx = (np.eye(3) - x[:, :, None] * x[:, None, :]) @ chord_derivative / length[:, None, None]
    projected_derivative = direction_derivative - axial_direction[:, None, None] * dx
    projected_derivative -= x[:, :, None] * (np.einsum("ei,eij->ej", direction, dx) + np.einsum("ei,eij->ej", x, direction_derivative))[:, None, :]
    dy = (np.eye(3) - y[:, :, None] * y[:, None, :]) @ projected_derivative / projected_length[:, None, None]
    dz = -skew_many(y) @ dx + skew_many(x) @ dy
    frame_spin = .5 * (skew_many(x) @ dx + skew_many(y) @ dy + skew_many(z) @ dz)
    angles = np.linalg.norm(relative, axis=2)
    coefficient = np.empty_like(angles)
    small = angles < 1e-4
    coefficient[small] = 1 / 12 + angles[small]**2 / 720 + angles[small]**4 / 30240
    coefficient[~small] = (1 - .5 * angles[~small] / np.tan(angles[~small] / 2)) / angles[~small]**2
    generators = skew_many(relative)
    log_derivative = np.eye(3) - .5 * generators + coefficient[..., None, None] * (generators @ generators)
    jacobian = np.zeros((count, 12, 12))
    jacobian[:, 6] = x @ chord_derivative
    for node in range(2):
        rows = slice(6 * node + 3, 6 * node + 6)
        nodal_spin = np.zeros((3, 12)); nodal_spin[:, rows] = np.eye(3)
        jacobian[:, rows] = log_derivative[:, node] @ inverse_frames @ (nodal_spin - frame_spin)
    result = deformation, frames, jacobian, frame_spin
    for value in result:
        value.flags.writeable = False
    return result


def beam_batch_kinematics(points, translations, rotations, reference_frames):
    """배치 모양은 [element,node,...]이고 결과는 단일 보 식과 동일합니다."""
    return _cached_beam_batch(len(points), *(np.asarray(value, dtype=np.float64).tobytes() for value in (points, translations, rotations, reference_frames)))


def beam_force(points: np.ndarray, translations: np.ndarray, rotations: np.ndarray, reference_frame: np.ndarray, local_stiffness: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """국소 에너지의 미분으로 global 내력을 얻어 힘·모멘트 평형을 지킵니다.

    좌표계가 변하면 국소 변형도 함께 변합니다. K*d를 단순히 회전하면
    그 효과를 잃어 내부력만으로도 순 모멘트가 생길 수 있습니다.
    """
    deformation, frame, jacobian, _ = beam_kinematics(points, translations, rotations, reference_frame)
    local_force = local_stiffness @ deformation
    return jacobian.T @ local_force, frame, float(deformation @ local_force / 2)


def beam_response(points: np.ndarray, translations: np.ndarray, rotations: np.ndarray, reference_frame: np.ndarray, local_stiffness: np.ndarray, consistent_tangent=True) -> tuple[np.ndarray, np.ndarray, float]:
    """내부력과 그 접선. 회전 좌표계 미분을 빠뜨리지 않도록 중심차분한다.

    이것은 선형 강성을 회전시킨 근사 접선이 아니다. 실제 force 함수를
    병진/미소 공간회전으로 미분하므로 좌표계 변화와 초기력 효과도 포함된다.
    선형 해석은 이 경로를 쓰지 않는다. 차분 간격 수렴은 별도 시험한다.
    """
    deformation, _, jacobian, _ = beam_kinematics(points, translations, rotations, reference_frame)
    local_force = local_stiffness @ deformation
    force, energy = jacobian.T @ local_force, float(deformation @ local_force / 2)
    if not consistent_tangent:
        # 시간 적분의 modified Newton에 쓰는 양의 material 부분입니다.
        # 내력/에너지는 근사하지 않습니다. 전체 잔차의 수렴이 느려지면
        # 호출자가 아래의 완전 접선으로 전환합니다.
        return force, jacobian.T @ local_stiffness @ jacobian, energy
    tangent = np.empty((12, 12))
    length = np.linalg.norm(points[1] - points[0])
    for column in range(12):
        node, component = divmod(column, 6)
        step = 2e-6 * (length if component < 3 else 1.)
        up, um, rp, rm = translations.copy(), translations.copy(), rotations.copy(), rotations.copy()
        if component < 3:
            up[node, component] += step
            um[node, component] -= step
        else:
            increment = np.eye(3)[component - 3] * step
            rp[node] = rotation_exp(increment) @ rp[node]
            rm[node] = rotation_exp(-increment) @ rm[node]
        tangent[:, column] = (beam_force(points, up, rp, reference_frame, local_stiffness)[0] - beam_force(points, um, rm, reference_frame, local_stiffness)[0]) / (2 * step)
    return force, tangent, energy


def truss_response(points: np.ndarray, translations: np.ndarray, E: float, area: float) -> tuple[np.ndarray, np.ndarray, float]:
    """축변형률=(현재 길이-기준 길이)/기준 길이. 축력 방향의 변화가 기하강성이다."""
    initial_length = np.linalg.norm(points[1] - points[0])
    chord = points[1] + translations[1] - points[0] - translations[0]
    length = np.linalg.norm(chord)
    if min(initial_length, length) <= 0:
        raise ValueError("truss element has collapsed or zero length")
    direction = chord / length
    extension = length - initial_length
    tension = E * area * extension / initial_length
    block = E * area / initial_length * np.outer(direction, direction) + tension / length * (np.eye(3) - np.outer(direction, direction))
    return np.r_[-tension * direction, tension * direction], np.block([[block, -block], [-block, block]]), float(tension * extension / 2)


def beam_geometric_stiffness(length: float, axial_force: float) -> np.ndarray:
    """일정 축력의 기하강성. 압축력이 음수이므로 횡방향 굽힘 강성이 감소한다."""
    matrix = np.zeros((12, 12))
    block = axial_force / (30 * length) * np.array([[36, 3 * length, -36, 3 * length], [3 * length, 4 * length**2, -3 * length, -length**2], [-36, -3 * length, 36, -3 * length], [3 * length, -length**2, -3 * length, 4 * length**2]])
    for indices, signs in (([1, 5, 7, 11], [1, 1, 1, 1]), ([2, 4, 8, 10], [1, -1, 1, -1])):
        matrix[np.ix_(indices, indices)] += block * np.outer(signs, signs)
    return matrix
