"""구조 재료의 작은 구성식: 변형률을 넣으면 응력과 접선 강성이 나옵니다.

이 모듈의 Voigt 순서는 ``xx, yy, zz, xy, yz, xz``입니다. 응력의 전단
성분은 실제 전단응력이고, 변형률의 전단 성분은 공학전단변형률
``gamma_xy = 2 * epsilon_xy``입니다. 따라서 ``stress @ strain``은 바로
단위 체적당 일입니다. 이 약속을 섞으면 전단 강성이 두 배 달라집니다.

아래 J2 모델은 *작은 변형률* 소성입니다. 강체 회전이나 유한 변형을
자동으로 처리하는 모델이 아니며, 요소의 객관적인 좌표 변환은 호출자가
소유합니다. 모든 함수는 입력 배열과 이미 확정한 소성 이력을 바꾸지 않습니다.
"""

from __future__ import annotations

import numpy as np


def isotropic_elasticity(E: float, nu: float) -> np.ndarray:
    """등방성 3차원 Hooke 법칙의 6×6 행렬을 만듭니다 (E의 단위: Pa)."""
    if E <= 0 or not -1 < nu < 0.5:
        raise ValueError("isotropic elasticity requires E > 0 and -1 < nu < 0.5")
    shear = E / (2 * (1 + nu))
    lame = E * nu / ((1 + nu) * (1 - 2 * nu))
    elasticity = np.zeros((6, 6))
    elasticity[:3, :3] = lame
    elasticity[np.arange(3), np.arange(3)] += 2 * shear
    elasticity[3:, 3:] = np.eye(3) * shear
    return elasticity


def orthotropic_elasticity(
    E1: float, E2: float, E3: float,
    nu12: float, nu23: float, nu13: float,
    G12: float, G23: float, G13: float,
) -> np.ndarray:
    """서로 직교하는 재료 1/2/3축에서의 탄성 행렬입니다.

    ``nu12``는 1방향 인장 때의 -epsilon_22 / epsilon_11입니다.
    상호성 ``nu12/E1 = nu21/E2``를 compliance(응력→변형률) 행렬에
    직접 넣으므로 사용자가 역방향 Poisson 비를 중복 입력하지 않습니다.
    재료축을 공간축으로 회전하는 일은 요소/단면이 담당합니다.
    """
    if min(E1, E2, E3, G12, G23, G13) <= 0:
        raise ValueError("orthotropic elastic and shear moduli must be positive")
    compliance = np.diag([1 / E1, 1 / E2, 1 / E3, 1 / G12, 1 / G23, 1 / G13])
    compliance[0, 1] = compliance[1, 0] = -nu12 / E1
    compliance[1, 2] = compliance[2, 1] = -nu23 / E2
    compliance[0, 2] = compliance[2, 0] = -nu13 / E1
    try:
        np.linalg.cholesky(compliance)
    except np.linalg.LinAlgError as error:
        raise ValueError("orthotropic coefficients must give positive elastic energy") from error
    return np.linalg.inv(compliance)


def orient_elasticity(elasticity: np.ndarray, material_axes: np.ndarray) -> np.ndarray:
    """재료 1/2/3축의 C[Pa]를 해석 xyz축 성분으로 옮깁니다.

    Q의 열은 공간에서 바라본 재료축입니다. 전역 단위 변형률을 하나씩
    가해서 epsilon_local=Q.T epsilon_global Q, sigma_global=Q sigma_local Q.T
    순서로 변환하면 전단의 2배 약속을 명시적으로 확인할 수 있습니다.
    회전은 재료가 저장하는 에너지를 바꾸지 않아야 합니다.
    """
    axes = np.asarray(material_axes, dtype=float)
    if axes.shape != (3, 3) or not np.allclose(axes.T @ axes, np.eye(3), rtol=0, atol=1e-10) or not np.isclose(np.linalg.det(axes), 1., rtol=0, atol=1e-10):
        raise ValueError("materialAxes must contain right-handed orthonormal axes as columns")
    result = np.empty((6, 6))
    pairs = ((0, 0), (1, 1), (2, 2), (0, 1), (1, 2), (0, 2))
    for column, (row, col) in enumerate(pairs):
        strain = np.zeros((3, 3))
        strain[row, col] = strain[col, row] = 1. if row == col else .5
        local_strain = axes.T @ strain @ axes
        engineering = np.array([local_strain[i, j] * (1 if i == j else 2) for i, j in pairs])
        stress = np.asarray(elasticity) @ engineering
        local_stress = np.array([[stress[0], stress[3], stress[5]], [stress[3], stress[1], stress[4]], [stress[5], stress[4], stress[2]]])
        global_stress = axes @ local_stress @ axes.T
        result[:, column] = [global_stress[i, j] for i, j in pairs]
    return result


def j2_return(
    strain: np.ndarray,
    plastic_strain: np.ndarray,
    equivalent_plastic_strain: float,
    E: float,
    nu: float,
    yield_stress: float,
    hardening: float = 0.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """J2/von Mises 소성 + 선형 등방 경화의 radial return입니다.

    먼저 이번 변형이 모두 탄성이라고 가정해 trial 응력을 계산합니다.
    항복면 밖이라면 편차응력만 원점 쪽으로 줄여 항복면에 되돌립니다.
    그때 늘어난 소성변형률과 항복반경을 *새 값*으로 반환합니다.
    Newton 반복이 실패하면 이 반환값을 버리면 됩니다. 입력 이력을
    수정하지 않으므로 실패한 반복이 재료를 영구적으로 변형시키지 않습니다.

    반환 접선은 이 이산 return mapping을 미분한 consistent tangent입니다.
    연속체의 탄소성 접선을 대신 넣으면 같은 Newton 수렴률을 얻지 못합니다.
    """
    if yield_stress <= 0 or hardening < 0:
        raise ValueError("J2 requires positive yield stress and nonnegative hardening")
    strain = np.asarray(strain, dtype=float).reshape(6)
    previous_plastic = np.asarray(plastic_strain, dtype=float).reshape(6)
    elasticity = isotropic_elasticity(E, nu)
    trial = elasticity @ (strain - previous_plastic)
    mean_stress = np.mean(trial[:3])
    deviator = trial.copy()
    deviator[:3] -= mean_stress
    # 대칭 응력 텐서에는 xy와 yx가 모두 있으므로 전단 제곱은 두 번 셉니다.
    stress_metric = np.array([1., 1., 1., 2., 2., 2.])
    equivalent_stress = np.sqrt(1.5 * np.dot(stress_metric * deviator, deviator))
    current_yield = yield_stress + hardening * equivalent_plastic_strain
    if equivalent_stress <= current_yield:
        return trial, elasticity, previous_plastic.copy(), float(equivalent_plastic_strain)

    shear = E / (2 * (1 + nu))
    plastic_increment = (equivalent_stress - current_yield) / (3 * shear + hardening)
    shrink = 1 - 3 * shear * plastic_increment / equivalent_stress
    stress = shrink * deviator
    stress[:3] += mean_stress
    flow_direction = 1.5 * stress_metric * deviator / equivalent_stress
    updated_plastic = previous_plastic + plastic_increment * flow_direction

    volume_direction = np.array([1., 1., 1., 0., 0., 0.])
    bulk = E / (3 * (1 - 2 * nu))
    volumetric = bulk * np.outer(volume_direction, volume_direction)
    tangent = volumetric + shrink * (elasticity - volumetric)
    tangent -= (
        9 * shear**2 / equivalent_stress**2
        * (1 / (3 * shear + hardening) - plastic_increment / equivalent_stress)
        * np.outer(deviator, deviator)
    )
    return stress, tangent, updated_plastic, float(equivalent_plastic_strain + plastic_increment)
