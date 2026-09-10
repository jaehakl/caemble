"""요소의 강체 운동을 제거하고 에너지에서 내력을 얻는 corotation입니다.

국소 강성을 공간으로 회전시키는 것만으로는 충분하지 않습니다. 변위가
바뀌면 움직이는 요소 좌표계도 바뀌므로 그 미분까지 내력에 들어가야 합니다.
이 교육용 구현은 국소 변형 d(q)의 Jacobian J를 중심차분하고
``force = J.T @ K_local @ d``로 가상일을 보존합니다. 접선은 이 실제
내력을 한 번 더 미분합니다. 해석적으로 펼친 전문 요소보다 계산은 느리지만
좌표계 미분을 생략하지 않으며 식과 구현의 대응을 따라가기 쉽습니다.
"""

from collections.abc import Callable, Mapping

import numpy as np

from .rotations import rotation_exp, rotation_log
from .shells import shell4_matrices, shell4_response


def _perturbed_configuration(
    translations: np.ndarray, rotations: np.ndarray, column: int, increment: float,
) -> tuple[np.ndarray, np.ndarray]:
    """한 Cartesian 병진 또는 한 공간 회전 증분을 독립 복사본에 적용합니다."""
    node, component = divmod(column, 6)
    translated, rotated = translations.copy(), rotations.copy()
    if component < 3:
        translated[node, component] += increment
    else:
        delta = np.zeros(3)
        delta[component - 3] = increment
        rotated[node] = rotation_exp(delta) @ rotated[node]
    return translated, rotated


def variational_force(
    deformation: Callable[[np.ndarray, np.ndarray], np.ndarray],
    translations: np.ndarray, rotations: np.ndarray, stiffness: np.ndarray,
    length_scale: float,
) -> tuple[np.ndarray, float, np.ndarray]:
    """f=J.T K d. 에너지 자체의 차분보다 무변형 근처의 상쇄 오차가 작습니다."""
    translations = np.asarray(translations, dtype=float)
    rotations = np.asarray(rotations, dtype=float)
    local = deformation(translations, rotations)
    local_force = stiffness @ local
    jacobian = np.empty((local.size, translations.shape[0] * 6))
    for column in range(jacobian.shape[1]):
        step = 2e-6 * (length_scale if column % 6 < 3 else 1.)
        plus = _perturbed_configuration(translations, rotations, column, step)
        minus = _perturbed_configuration(translations, rotations, column, -step)
        jacobian[:, column] = (deformation(*plus) - deformation(*minus)) / (2 * step)
    return jacobian.T @ local_force, float(local @ local_force / 2), local


def variational_response(
    deformation: Callable[[np.ndarray, np.ndarray], np.ndarray],
    translations: np.ndarray, rotations: np.ndarray, stiffness: np.ndarray,
    length_scale: float,
) -> tuple[np.ndarray, np.ndarray, float, np.ndarray]:
    """내력과 공간 증분에 대한 접선을 반환합니다.

    회전은 exp(delta) @ R로 갱신합니다. 유한 회전군에서 공간 모멘트를
    공간 회전으로 미분한 행렬은 일반적인 벡터 좌표 Hessian과 다르므로
    접선을 임의로 대칭화하지 않습니다. 실제 갱신 규칙과 같은 접선입니다.
    """
    translations = np.asarray(translations, dtype=float)
    rotations = np.asarray(rotations, dtype=float)
    force, energy, local = variational_force(deformation, translations, rotations, stiffness, length_scale)
    tangent = np.empty((force.size, force.size))
    for column in range(force.size):
        # 두 겹의 차분에서 반올림 오차가 증폭되지 않도록 바깥 간격은 조금 큽니다.
        step = 2e-5 * (length_scale if column % 6 < 3 else 1.)
        plus = _perturbed_configuration(translations, rotations, column, step)
        minus = _perturbed_configuration(translations, rotations, column, -step)
        force_plus = variational_force(deformation, *plus, stiffness, length_scale)[0]
        force_minus = variational_force(deformation, *minus, stiffness, length_scale)[0]
        tangent[:, column] = (force_plus - force_minus) / (2 * step)
    return force, tangent, energy, local


def shell_deformation(
    coordinates: np.ndarray, translations: np.ndarray, rotations: np.ndarray,
) -> np.ndarray:
    """Kabsch 최적 강체 회전 뒤에 남은 병진과 절점 상대회전입니다.

    기준/현재 절점의 중심을 먼저 빼서 병진을 제거하고 SVD로 가장 가까운
    *proper rotation*을 구합니다. determinant 보정으로 반사를 회전으로
    오인하지 않습니다. 현재 절점의 판 밖 변형은 버리지 않습니다.
    """
    reference = coordinates - coordinates.mean(axis=0)
    current = coordinates + translations
    centered = current - current.mean(axis=0)
    left, _, right = np.linalg.svd(reference.T @ centered)
    correction = np.diag([1., 1., np.linalg.det(right.T @ left.T)])
    frame = right.T @ correction @ left.T
    deformation = np.empty((4, 6))
    deformation[:, :3] = centered @ frame - reference
    for node in range(4):
        deformation[node, 3:] = rotation_log(frame.T @ rotations[node])
    return deformation.reshape(24)


def shell_corotational_response(
    coordinates: np.ndarray, translations: np.ndarray, rotations: np.ndarray,
    section: Mapping[str, object],
) -> tuple[np.ndarray, np.ndarray, float, dict[str, np.ndarray]]:
    """global f24/K24, 탄성 에너지, shell 기준축의 응력·변형률입니다.

    기준 coordinates는 평면이어야 하지만 현재 형상은 휘어질 수 있습니다.
    rotations는 기준 global 축에서 현재 global 축으로의 4개 회전행렬입니다.
    실제 변형의 회전은 작고 강체 회전은 큰 corotational 가정을 사용합니다.
    """
    coordinates = np.asarray(coordinates, dtype=float)
    if coordinates.shape != (4, 3):
        raise ValueError("corotational shell requires four 3D reference coordinates")
    stiffness, _ = shell4_matrices(coordinates, section)
    length_scale = np.max(np.linalg.norm(coordinates - coordinates.mean(axis=0), axis=1))
    force, tangent, energy, local = variational_response(
        lambda u, R: shell_deformation(coordinates, u, R),
        translations, rotations, stiffness, length_scale,
    )
    return force, tangent, energy, shell4_response(coordinates, local, section)
