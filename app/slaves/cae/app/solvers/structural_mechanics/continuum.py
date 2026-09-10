"""작은 요소를 적분해서 조립하기 직전의 연속체 요소 행렬을 만듭니다.

``tri3/quad4``는 평면의 절점당 (ux, uy), ``tet4/hex8``는 공간의
(ux, uy, uz)를 사용합니다. 모든 행렬은 전달받은 Cartesian 좌표계입니다.
기본 과정은 모양함수 N → 공간 미분 → 변형률 행렬 B → B.T C B 적분입니다.
노드 순서는 tri/tet의 양의 Jacobian, quad/hex의 표준 자연좌표 순서입니다.
Hex8은 2×2×2 완전적분이므로 hourglass 자유도는 없습니다. 대신 거의
비압축성인 문제에는 체적 locking이 생길 수 있는 저차 요소입니다.
"""

from __future__ import annotations

from collections.abc import Mapping
from itertools import product

import numpy as np

from .materials import j2_return


def plane_elasticity(elasticity: np.ndarray, plane: str = "stress") -> np.ndarray:
    """3D C를 [xx, yy, xy] 평면 법칙으로 줄입니다.

    평면변형률은 out-of-plane 변형률을 0으로 고정합니다. 평면응력은
    out-of-plane 응력이 0이 되도록 그 변형률을 풀어 제거합니다. 두 경우의
    행렬은 Poisson 효과 때문에 다릅니다.
    """
    elasticity = np.asarray(elasticity, dtype=float)
    if plane not in {"stress", "strain"}:
        raise ValueError("plane must be 'stress' or 'strain'")
    if elasticity.shape == (3, 3):
        return elasticity.copy()
    inside = [0, 1, 3]
    outside = [2, 4, 5]
    matrix = elasticity[np.ix_(inside, inside)].copy()
    if plane == "stress":
        matrix -= elasticity[np.ix_(inside, outside)] @ np.linalg.solve(
            elasticity[np.ix_(outside, outside)], elasticity[np.ix_(outside, inside)]
        )
    return matrix


def shape_functions(kind: str, natural: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """N과 자연좌표에 대한 dN을 반환합니다. 행은 절점, 열은 자연좌표입니다."""
    natural = np.asarray(natural, dtype=float)
    if kind == "tri3":
        r, s = natural
        return np.array([1 - r - s, r, s]), np.array([[-1., -1.], [1., 0.], [0., 1.]])
    if kind == "tet4":
        r, s, t = natural
        return np.array([1 - r - s - t, r, s, t]), np.array([
            [-1., -1., -1.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.],
        ])
    if kind == "quad4":
        corners = np.array([[-1., -1.], [1., -1.], [1., 1.], [-1., 1.]])
    elif kind == "hex8":
        corners = np.array([
            [-1., -1., -1.], [1., -1., -1.], [1., 1., -1.], [-1., 1., -1.],
            [-1., -1., 1.], [1., -1., 1.], [1., 1., 1.], [-1., 1., 1.],
        ])
    else:
        raise ValueError(f"unsupported continuum element {kind!r}")
    factors = (1 + corners * natural) / 2
    values = np.prod(factors, axis=1)
    derivatives = np.empty_like(corners)
    for axis in range(corners.shape[1]):
        other_axes = [index for index in range(corners.shape[1]) if index != axis]
        derivatives[:, axis] = corners[:, axis] / 2 * np.prod(factors[:, other_axes], axis=1)
    return values, derivatives


def integration_points(
    kind: str, coordinates: np.ndarray, thickness: float = 1.0, plane: str = "stress",
) -> list[tuple[np.ndarray, np.ndarray, float, np.ndarray]]:
    """각 적분점의 (N, B, 실제 체적 가중치, dN/dx)을 반환합니다.

    tri/tet도 질량행렬 N.T N을 정확히 적분할 수 있는 2차 정확도 규칙을
    씁니다. 상수 변형률 요소라고 질량까지 한 점 적분하면 질량이 rank
    deficient해져 고유진동 문제를 망칩니다.
    """
    coordinates = np.asarray(coordinates, dtype=float)
    if kind == "tri3":
        samples = [(np.array(point), 1 / 6) for point in [(1 / 6, 1 / 6), (2 / 3, 1 / 6), (1 / 6, 2 / 3)]]
        dimension, nodes = 2, 3
    elif kind == "tet4":
        a, b = (5 + 3 * np.sqrt(5)) / 20, (5 - np.sqrt(5)) / 20
        samples = [(np.array(point), 1 / 24) for point in [(b, b, b), (a, b, b), (b, a, b), (b, b, a)]]
        dimension, nodes = 3, 4
    elif kind in {"quad4", "hex8"}:
        dimension, nodes = (2, 4) if kind == "quad4" else (3, 8)
        samples = [(np.array(point), 1.) for point in product((-1 / np.sqrt(3), 1 / np.sqrt(3)), repeat=dimension)]
    else:
        raise ValueError(f"unsupported continuum element {kind!r}")
    if coordinates.shape != (nodes, dimension):
        raise ValueError(f"{kind} coordinates must have shape {(nodes, dimension)}")
    if dimension == 2 and (thickness <= 0 or plane not in {"stress", "strain"}):
        raise ValueError("plane elements require positive thickness and stress/strain mode")

    result = []
    for natural, quadrature_weight in samples:
        values, derivatives = shape_functions(kind, natural)
        jacobian = coordinates.T @ derivatives
        determinant = float(np.linalg.det(jacobian))
        if determinant <= 0:
            raise ValueError(f"{kind} has an inverted or degenerate Jacobian")
        gradients = derivatives @ np.linalg.inv(jacobian)
        B = np.zeros((3 if dimension == 2 else 6, nodes * dimension))
        for node, gradient in enumerate(gradients):
            offset = node * dimension
            B[0, offset] = gradient[0]
            B[1, offset + 1] = gradient[1]
            if dimension == 2:
                B[2, offset:offset + 2] = gradient[1], gradient[0]
            else:
                B[2, offset + 2] = gradient[2]
                B[3, offset:offset + 2] = gradient[1], gradient[0]
                B[4, offset + 1:offset + 3] = gradient[2], gradient[1]
                B[5, offset] = gradient[2]
                B[5, offset + 2] = gradient[0]
        weight = quadrature_weight * determinant * (thickness if dimension == 2 else 1)
        result.append((values, B, weight, gradients))
    return result


def element_matrices(
    kind: str, coordinates: np.ndarray, elasticity: np.ndarray,
    density: float, thickness: float = 1.0, plane: str = "stress",
) -> tuple[np.ndarray, np.ndarray]:
    """선형 강성 K와 consistent 질량 M을 만듭니다. 질량은 rho N.T N입니다."""
    coordinates = np.asarray(coordinates, dtype=float)
    dimension = coordinates.shape[1]
    matrix = plane_elasticity(elasticity, plane) if dimension == 2 else np.asarray(elasticity)
    size = coordinates.size
    stiffness, mass = np.zeros((size, size)), np.zeros((size, size))
    if density < 0:
        raise ValueError("mass density cannot be negative")
    for N, B, weight, _ in integration_points(kind, coordinates, thickness, plane):
        stiffness += B.T @ matrix @ B * weight
        mass += np.kron(np.outer(N, N), np.eye(dimension)) * density * weight
    return stiffness, mass


def element_response(
    kind: str, coordinates: np.ndarray, displacement: np.ndarray,
    elasticity: np.ndarray, thickness: float = 1.0, plane: str = "stress",
    *, full_stress: bool = False,
) -> tuple[np.ndarray, np.ndarray]:
    """적분점별 변형률과 응력입니다. 절점 응력으로 임의 평균하지 않습니다.

    평면의 기본 반환은 [xx,yy,xy]다. full_stress=True이면 변형률은 그대로
    두고 응력만 3D Voigt 6성분으로 회복한다. 평면변형률의 epsilon_zz=0은
    sigma_zz=0이라는 뜻이 아니다. 두께 방향 구속 때문에 반응 응력이 생긴다.
    """
    matrix = plane_elasticity(elasticity, plane) if kind in {"tri3", "quad4"} else np.asarray(elasticity)
    displacement = np.asarray(displacement).reshape(-1)
    strains = np.array([B @ displacement for _, B, _, _ in integration_points(kind, coordinates, thickness, plane)])
    if full_stress and kind in {"tri3", "quad4"}:
        elasticity = np.asarray(elasticity)
        if elasticity.shape != (6, 6):
            raise ValueError("full plane stress recovery requires the 3D elasticity matrix")
        inside, outside = [0, 1, 3], [2, 4, 5]
        full_strains = np.zeros((len(strains), 6))
        full_strains[:, inside] = strains
        if plane == "stress":
            # 자유 두께 방향의 응력이 0이 되도록 Poisson 수축을 복원한다.
            full_strains[:, outside] = -np.linalg.solve(elasticity[np.ix_(outside, outside)], elasticity[np.ix_(outside, inside)] @ strains.T).T
        return strains, full_strains @ elasticity.T
    return strains, strains @ matrix.T


def geometric_stiffness(
    kind: str, coordinates: np.ndarray, stress: np.ndarray,
    thickness: float = 1.0, plane: str = "stress",
) -> np.ndarray:
    """초기응력 강성: 인장은 양수, 압축은 음수로 횡변형 저항을 바꿉니다.

    선형 좌굴은 보통 K phi = lambda (-Kg) phi로 풉니다. 입력 응력은
    하나의 일정 응력 또는 위 integration_points 순서의 적분점 응력입니다.
    """
    coordinates = np.asarray(coordinates, dtype=float)
    dimension = coordinates.shape[1]
    samples = integration_points(kind, coordinates, thickness, plane)
    stresses = np.asarray(stress, dtype=float)
    if stresses.ndim == 1:
        stresses = np.broadcast_to(stresses, (len(samples), stresses.size))
    if len(stresses) != len(samples):
        raise ValueError("prestress must have one value per integration point")
    result = np.zeros((coordinates.size, coordinates.size))
    for (_, _, weight, gradients), values in zip(samples, stresses, strict=True):
        if dimension == 2:
            tensor = np.array([[values[0], values[2]], [values[2], values[1]]])
        else:
            tensor = np.array([
                [values[0], values[3], values[5]],
                [values[3], values[1], values[4]],
                [values[5], values[4], values[2]],
            ])
        result += np.kron(gradients @ tensor @ gradients.T, np.eye(dimension)) * weight
    return result


def element_nonlinear_response(
    kind: str, coordinates: np.ndarray, displacement: np.ndarray,
    material: Mapping[str, float], committed_history: Mapping[str, np.ndarray] | None = None,
    thickness: float = 1.0,
) -> tuple[np.ndarray, np.ndarray, dict[str, np.ndarray], np.ndarray]:
    """Solid J2의 내력·접선·미확정 이력·응력을 한 번에 계산합니다.

    기하학적으로는 작은 변형입니다. 입력은 이번 시도의 *전체 변위*와
    직전에 수렴한 소성 이력입니다. Newton의 각 시도에는 동일한
    committed_history를 넘기고, 수렴한 뒤에만 trial_history를 채택합니다.
    """
    if kind not in {"tet4", "hex8"}:
        raise ValueError("J2 integration is currently implemented for tet4 and hex8 solids")
    samples = integration_points(kind, coordinates, thickness)
    previous = committed_history or {}
    plastic = np.asarray(previous.get("plasticStrain", np.zeros((len(samples), 6))))
    equivalent = np.asarray(previous.get("equivalentPlasticStrain", np.zeros(len(samples))))
    if plastic.shape != (len(samples), 6) or equivalent.shape != (len(samples),):
        raise ValueError("J2 history must match the element integration points")
    displacement = np.asarray(displacement).reshape(-1)
    internal, tangent = np.zeros(displacement.size), np.zeros((displacement.size, displacement.size))
    updated_plastic, updated_equivalent, stresses = [], [], []
    for index, (_, B, weight, _) in enumerate(samples):
        stress, elasticity, next_plastic, next_equivalent = j2_return(
            B @ displacement, plastic[index], float(equivalent[index]),
            material["E"], material["nu"], material["yieldStress"], material.get("hardening", 0.),
        )
        internal += B.T @ stress * weight
        tangent += B.T @ elasticity @ B * weight
        updated_plastic.append(next_plastic)
        updated_equivalent.append(next_equivalent)
        stresses.append(stress)
    return internal, tangent, {
        "plasticStrain": np.asarray(updated_plastic),
        "equivalentPlasticStrain": np.asarray(updated_equivalent),
    }, np.asarray(stresses)
