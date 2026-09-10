"""평면 기준 형상의 4절점 MITC4 shell과 적층 단면 적분입니다.

절점당 자유도는 (ux, uy, uz, rx, ry, rz)입니다. rx/ry/rz는 오른손
법칙의 작은 회전입니다. 중립면에서 z만큼 떨어진 점의 변위는
``u = u0 + z*ry, v = v0 - z*rx``입니다. 따라서 횡전단변형률은
``gamma_xz = dw/dx + ry, gamma_yz = dw/dy - rx``가 됩니다.

MITC4는 전단을 한 점에서 적분하는 요소가 아닙니다. 변의 중점 네 곳에서
자연좌표 방향의 전단을 먼저 얻고, 그것을 요소 내부에 보간하는 *tying*
방법입니다. 아래 구현도 그 네 점을 명시하며 2×2 적분을 사용합니다.
큰 회전의 객관성은 호출 측 corotational 요소가 담당합니다.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from itertools import product

import numpy as np

from .continuum import plane_elasticity, shape_functions
from .materials import isotropic_elasticity
from .rotations import skew


def laminate_section(plies: Sequence[Mapping[str, object]]) -> dict[str, object]:
    """아래쪽→위쪽 ply를 적분해 A/B/D/횡전단 강성과 질량모멘트를 만듭니다.

    각 ply는 thickness[m], angle[rad], density[kg/m3]와
    E1/E2/nu12/G12/G13/G23[Pa, 무차원]를 가집니다. 또는 이미 구성한
    재료축 ``elasticity``(3×3 평면응력 또는 6×6 3D C)를 넘길 수 있습니다.
    G13/G23은 횡전단에 따로 필요합니다. 배치 angle/thickness는 재료
    상수가 아닌 *단면 배치*이며 Material 모델에 숨기지 않습니다.

    A는 막 인장, D는 굽힘, B는 인장↔굽힘 연결입니다. 대칭 적층이면
    B가 0이 됩니다. 기준면은 전체 두께의 가운데이며 질량 중심이 아닙니다.
    """
    if not plies:
        raise ValueError("a shell laminate requires at least one ply")
    thickness = sum(float(ply["thickness"]) for ply in plies)
    if any(float(ply["thickness"]) <= 0 for ply in plies):
        raise ValueError("ply thickness must be positive")
    A, B, D, transverse = np.zeros((3, 3)), np.zeros((3, 3)), np.zeros((3, 3)), np.zeros((2, 2))
    mass0 = mass1 = mass2 = 0.
    bottom = -thickness / 2
    layers = []
    for ply in plies:
        top = bottom + float(ply["thickness"])
        density = float(ply["density"])
        if density < 0:
            raise ValueError("ply mass density cannot be negative")
        if "elasticity" in ply:
            local = plane_elasticity(np.asarray(ply["elasticity"]))
        else:
            E1, E2, nu12, G12 = (float(ply[key]) for key in ("E1", "E2", "nu12", "G12"))
            if min(E1, E2, G12) <= 0:
                raise ValueError("ply moduli must be positive")
            compliance = np.array([[1 / E1, -nu12 / E1, 0.], [-nu12 / E1, 1 / E2, 0.], [0., 0., 1 / G12]])
            try:
                np.linalg.cholesky(compliance)
            except np.linalg.LinAlgError as error:
                raise ValueError("ply coefficients must give positive elastic energy") from error
            local = np.linalg.inv(compliance)
        angle = float(ply.get("angle", 0.))
        c, s = np.cos(angle), np.sin(angle)
        # 공학전단변형률을 사용하므로 세 번째 행에는 2*c*s가 등장합니다.
        strain_rotation = np.array([
            [c*c, s*s, c*s], [s*s, c*c, -c*s], [-2*c*s, 2*c*s, c*c-s*s],
        ])
        rotated = strain_rotation.T @ local @ strain_rotation
        shear_rotation = np.array([[c, s], [-s, c]])
        G13, G23 = float(ply["G13"]), float(ply["G23"])
        if min(G13, G23) <= 0:
            raise ValueError("ply transverse shear moduli must be positive")
        shear = shear_rotation.T @ np.diag([G13, G23]) @ shear_rotation
        dz = top - bottom
        dz2 = (top**2 - bottom**2) / 2
        dz3 = (top**3 - bottom**3) / 3
        A += rotated * dz
        B += rotated * dz2
        D += rotated * dz3
        # 5/6은 직사각형 단면의 일정 전단변형률에 대한 에너지 보정입니다.
        transverse += (5 / 6) * shear * dz
        mass0 += density * dz
        mass1 += density * dz2
        mass2 += density * dz3
        layers.append({"bottom": bottom, "top": top, "elasticity": rotated, "strainRotation": strain_rotation})
        bottom = top
    return {
        "A": A, "B": B, "D": D, "As": transverse,
        "mass0": mass0, "mass1": mass1, "mass2": mass2,
        "thickness": thickness, "plies": tuple(layers),
    }


def isotropic_section(E: float, nu: float, thickness: float, density: float) -> dict[str, object]:
    """단일 등방성 ply도 같은 적층 적분 경로로 계산합니다."""
    elasticity = isotropic_elasticity(E, nu)
    return laminate_section([{
        "elasticity": elasticity, "G13": elasticity[5, 5], "G23": elasticity[4, 4],
        "thickness": thickness, "density": density, "angle": 0.,
    }])


def shell_frame(coordinates: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """평면 좌표 xy와 global 24 DOF → local 24 DOF 변환을 반환합니다."""
    coordinates = np.asarray(coordinates, dtype=float)
    if coordinates.shape == (4, 2):
        return coordinates.copy(), np.eye(24)
    if coordinates.shape != (4, 3):
        raise ValueError("shell4 coordinates must have shape (4,2) or (4,3)")
    first = coordinates[1] - coordinates[0]
    fourth = coordinates[3] - coordinates[0]
    normal = np.cross(first, fourth)
    if np.linalg.norm(first) == 0 or np.linalg.norm(normal) == 0:
        raise ValueError("shell4 needs a nondegenerate reference plane")
    first = first / np.linalg.norm(first)
    normal = normal / np.linalg.norm(normal)
    second = np.cross(normal, first)
    rotation = np.array([first, second, normal])
    local = (coordinates - coordinates[0]) @ rotation.T
    scale = np.max(np.linalg.norm(coordinates - coordinates[0], axis=1))
    if np.max(np.abs(local[:, 2])) > 1e-10 * scale:
        raise ValueError("shell4 reference nodes must be planar; split a warped surface into planar elements")
    transform = np.kron(np.eye(8), rotation)
    return local[:, :2], transform


def shell4_operators(
    coordinates: np.ndarray, natural: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, float, np.ndarray]:
    """local xy에서 (N,막 B,굽힘 B,MITC전단 B,drilling B,detJ,grad N)."""
    coordinates = np.asarray(coordinates, dtype=float)
    r, s = natural
    N, derivatives = shape_functions("quad4", np.asarray(natural))
    jacobian = coordinates.T @ derivatives
    determinant = float(np.linalg.det(jacobian))
    if determinant <= 0:
        raise ValueError("shell4 has an inverted or degenerate Jacobian")
    gradients = derivatives @ np.linalg.inv(jacobian)
    membrane, bending = np.zeros((3, 24)), np.zeros((3, 24))
    drilling = np.zeros(24)
    for node, (dx, dy) in enumerate(gradients):
        i = 6 * node
        membrane[0, i] = dx
        membrane[1, i + 1] = dy
        membrane[2, i:i+2] = dy, dx
        bending[0, i + 4] = dx
        bending[1, i + 3] = -dy
        bending[2, i + 3:i + 5] = -dx, dy
        # drilling은 물리적 두께 방향 회전과 평면 변위의 spin을 연결합니다.
        # rz 자체를 0으로 벌점 처리하면 강체 회전까지 막아 버립니다.
        drilling[i:i+2] = 0.5 * dy, -0.5 * dx
        drilling[i + 5] = N[node]

    tying = []
    for point, axis in [((0., -1.), 0), ((0., 1.), 0), ((-1., 0.), 1), ((1., 0.), 1)]:
        tied_N, tied_derivatives = shape_functions("quad4", np.asarray(point))
        tangent = coordinates.T @ tied_derivatives[:, axis]
        row = np.zeros(24)
        for node in range(4):
            row[6 * node + 2] = tied_derivatives[node, axis]
            row[6 * node + 3] = -tangent[1] * tied_N[node]
            row[6 * node + 4] = tangent[0] * tied_N[node]
        tying.append(row)
    covariant = np.array([
        0.5 * (1 - s) * tying[0] + 0.5 * (1 + s) * tying[1],
        0.5 * (1 - r) * tying[2] + 0.5 * (1 + r) * tying[3],
    ])
    # 자연좌표 접선은 보통 직교 단위벡터가 아닙니다. 역 Jacobian으로
    # 다시 Cartesian gamma_xz/gamma_yz로 바꿔야 찌그러진 사각형도 맞습니다.
    shear = np.linalg.solve(jacobian.T, covariant)
    return N, membrane, bending, shear, drilling, determinant, gradients


def shell4_matrices(
    coordinates: np.ndarray, section: Mapping[str, object], drilling_factor: float = 1e-4,
) -> tuple[np.ndarray, np.ndarray]:
    """MITC4의 K24/M24. 3D 입력에는 global 행렬을 반환합니다.

    rz는 수치적으로 도입한 drilling 자유도이므로 물리 질량을 발명하지
    않습니다. M의 이 좌표는 0입니다. 고유치 해석에서는 이 무질량 자유도를
    정적 축약하거나 semidefinite M을 지원하는 해법을 사용해야 합니다.
    """
    local, transform = shell_frame(coordinates)
    A, B, D, As = (np.asarray(section[key]) for key in ("A", "B", "D", "As"))
    if drilling_factor <= 0:
        raise ValueError("shell drilling stabilization must be positive")
    stiffness, mass = np.zeros((24, 24)), np.zeros((24, 24))
    inertia = np.zeros((6, 6))
    inertia[:3, :3] = np.eye(3) * float(section["mass0"])
    inertia[3, 3] = inertia[4, 4] = float(section["mass2"])
    inertia[0, 4] = inertia[4, 0] = float(section["mass1"])
    inertia[1, 3] = inertia[3, 1] = -float(section["mass1"])
    for point in product((-1 / np.sqrt(3), 1 / np.sqrt(3)), repeat=2):
        N, membrane, bending, shear, drilling, weight, _ = shell4_operators(local, np.asarray(point))
        stiffness += (
            membrane.T @ A @ membrane + membrane.T @ B @ bending
            + bending.T @ B.T @ membrane + bending.T @ D @ bending
            + shear.T @ As @ shear
            + drilling_factor * A[2, 2] * np.outer(drilling, drilling)
        ) * weight
        mass += np.kron(np.outer(N, N), inertia) * weight
    return transform.T @ stiffness @ transform, transform.T @ mass @ transform


def shell4_mass_moments(coordinates, section):
    """기준 면적에서 적분한 Ni*Nj와 두께 질량모멘트를 한 번 준비합니다.

    mass0/1/2는 각각 ∫rho dz, ∫rho*z dz, ∫rho*z² dz입니다.
    기준 법선은 global 벡터이며, 현재 법선은 절점별 R_i @ normal입니다.
    """
    local, transform = shell_frame(coordinates)
    shape_mass = np.zeros((4, 4))
    for point in product((-1 / np.sqrt(3), 1 / np.sqrt(3)), repeat=2):
        N, derivatives = shape_functions("quad4", np.asarray(point))
        shape_mass += np.outer(N, N) * np.linalg.det(local.T @ derivatives)
    moments = np.array([section[name] for name in ("mass0", "mass1", "mass2")])
    return transform[2, :3].copy(), moments[:, None, None] * shape_mass


def shell4_director_mass(normal, moments, orientations, with_derivatives=False):
    """절점의 실제 두께 방향에서 공간 질량행렬과 회전 미분을 구합니다.

    중립면에서 z만큼 떨어진 물질점은 x_i + z*n_i에 있습니다. 속도는
    v_i + z*(omega_i × n_i)이므로, 이 속도의 제곱을 두께와 면적에서
    적분하면 아래 6×6 블록을 얻습니다. 각 절점의 법선 n_i를 사용해야
    굽어지는 판의 관성이 맞습니다. 요소 전체의 평균 법선을 쓰면 질량이
    없는 drilling 회전이 가짜 관성 토크를 만들어 과도 해석이 불안정해집니다.

    법선 주위의 회전은 omega_i × n_i=0입니다. 이 질량 없는 방향은
    그대로 유지하며, 안정화를 위해 가짜 회전 관성을 추가하지 않습니다.
    derivatives[column,row,col]은 exp(delta)@R 공간 회전의 정확한 미분입니다.
    """
    directors = np.asarray(orientations) @ np.asarray(normal)
    arms = np.array([-skew(director) for director in directors])
    mass = np.zeros((24, 24))
    derivatives = np.zeros((24, 24, 24))
    if with_derivatives:
        changes = np.array([[-skew(np.cross(axis, n)) for axis in np.eye(3)] for n in directors])
    for i in range(4):
        translation_i, rotation_i = slice(6*i, 6*i+3), slice(6*i+3, 6*i+6)
        for j in range(4):
            translation_j, rotation_j = slice(6*j, 6*j+3), slice(6*j+3, 6*j+6)
            mass0, mass1, mass2 = moments[:, i, j]
            mass[translation_i, translation_j] = mass0 * np.eye(3)
            mass[translation_i, rotation_j] = mass1 * arms[j]
            mass[rotation_i, translation_j] = mass1 * arms[i].T
            mass[rotation_i, rotation_j] = mass2 * arms[i].T @ arms[j]
            if with_derivatives:
                for axis in range(3):
                    column_i, column_j = 6*i+3+axis, 6*j+3+axis
                    derivatives[column_i, rotation_i, translation_j] += mass1 * changes[i, axis].T
                    derivatives[column_j, translation_i, rotation_j] += mass1 * changes[j, axis]
                    derivatives[column_i, rotation_i, rotation_j] += mass2 * changes[i, axis].T @ arms[j]
                    derivatives[column_j, rotation_i, rotation_j] += mass2 * arms[i].T @ changes[j, axis]
    return mass, derivatives


def shell4_response(
    coordinates: np.ndarray, displacement: np.ndarray, section: Mapping[str, object],
) -> dict[str, np.ndarray]:
    """막/굽힘/횡전단의 적분점 결과와 각 ply의 위아래 응력을 반환합니다.

    force와 shearForce는 N/m, moment는 N입니다(단위 폭당 N*m).
    plyStress[q,ply,면,xx/yy/xy]는 shell 기준축 성분이며 면 순서는 아래/위입니다.
    """
    local, transform = shell_frame(coordinates)
    displacement = transform @ np.asarray(displacement).reshape(24)
    strains, curvatures, shears = [], [], []
    for point in product((-1 / np.sqrt(3), 1 / np.sqrt(3)), repeat=2):
        _, membrane, bending, shear, _, _, _ = shell4_operators(local, np.asarray(point))
        strains.append(membrane @ displacement)
        curvatures.append(bending @ displacement)
        shears.append(shear @ displacement)
    strains, curvatures, shears = np.asarray(strains), np.asarray(curvatures), np.asarray(shears)
    A, B, D, As = (np.asarray(section[key]) for key in ("A", "B", "D", "As"))
    ply_stress = []
    for strain, curvature in zip(strains, curvatures, strict=True):
        ply_stress.append([
            [np.asarray(ply["elasticity"]) @ (strain + float(ply[face]) * curvature) for face in ("bottom", "top")]
            for ply in section["plies"]
        ])
    return {
        "membraneStrain": strains, "curvature": curvatures, "shearStrain": shears,
        "force": strains @ A.T + curvatures @ B.T,
        "moment": strains @ B + curvatures @ D.T,
        "shearForce": shears @ As.T,
        "plyStress": np.asarray(ply_stress),
    }


def shell4_geometric_stiffness(coordinates: np.ndarray, membrane_forces: np.ndarray) -> np.ndarray:
    """막 초기응력 Nxx/Nyy/Nxy에 의한 global 기하강성입니다.

    두께 적분을 마친 막력[N/m]을 사용합니다. 초기 굽힘모멘트의 추가
    기하강성은 포함하지 않습니다. 압축 막력은 좌굴 방향 강성을 줄입니다.
    """
    local, transform = shell_frame(coordinates)
    forces = np.asarray(membrane_forces)
    if forces.ndim == 1:
        forces = np.broadcast_to(forces, (4, 3))
    if forces.shape != (4, 3):
        raise ValueError("shell prestress requires (3,) or (4,3) membrane forces")
    result = np.zeros((24, 24))
    for point, stress in zip(product((-1 / np.sqrt(3), 1 / np.sqrt(3)), repeat=2), forces, strict=True):
        _, _, _, _, _, weight, gradients = shell4_operators(local, np.asarray(point))
        tensor = np.array([[stress[0], stress[2]], [stress[2], stress[1]]])
        scalar = gradients @ tensor @ gradients.T * weight
        for axis in range(3):
            indices = np.arange(4) * 6 + axis
            result[np.ix_(indices, indices)] += scalar
    return transform.T @ result @ transform
