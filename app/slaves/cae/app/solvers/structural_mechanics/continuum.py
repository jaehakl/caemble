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
from .rotations import rotation_log_many


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


def _symmetric_voigt(tensor: np.ndarray) -> np.ndarray:
    """3x3 symmetric tensor -> engineering-strain ordered Voigt vector."""
    return np.array([
        tensor[0, 0], tensor[1, 1], tensor[2, 2],
        2 * tensor[0, 1], 2 * tensor[1, 2], 2 * tensor[0, 2],
    ])


def _stress_tensor(values: np.ndarray) -> np.ndarray:
    """[xx,yy,zz,xy,yz,xz] stress vector -> symmetric tensor."""
    return np.array([
        [values[0], values[3], values[5]],
        [values[3], values[1], values[4]],
        [values[5], values[4], values[2]],
    ])


def tet4_deformation_gradient(
    coordinates: np.ndarray, displacement: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, float]:
    """Return ``F``, reference shape gradients and volume for a linear tet."""
    coordinates = np.asarray(coordinates, dtype=float)
    displacement = np.asarray(displacement, dtype=float)
    if coordinates.shape != (4, 3) or displacement.shape != (4, 3):
        raise ValueError("tet4 corotation requires four 3D coordinates and displacements")
    samples = integration_points("tet4", coordinates)
    gradients = samples[0][3]
    volume = float(sum(sample[2] for sample in samples))
    deformation = (coordinates + displacement).T @ gradients
    if np.linalg.det(deformation) <= 1e-10:
        raise ValueError("tet4 current configuration is inverted or degenerate")
    return deformation, gradients, volume


def _polar_decomposition(
    deformation: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return proper rotation, right stretch, stretches and material axes."""
    left, _, right = np.linalg.svd(deformation)
    rotation = left @ right
    if np.linalg.det(rotation) <= 0:
        raise ValueError("tet4 current configuration is inverted or degenerate")
    stretch = rotation.T @ deformation
    stretch = (stretch + stretch.T) / 2
    stretches, directions = np.linalg.eigh(stretch)
    if np.min(stretches) <= 1e-10:
        raise ValueError("tet4 polar stretch is singular")
    return rotation, stretch, stretches, directions


def _tet4_corotated_stress(
    deformation: np.ndarray, elasticity: np.ndarray,
) -> tuple[np.ndarray, float, np.ndarray, np.ndarray]:
    """First Piola stress for a polar-corotated small-strain solid.

    The constitutive law remains the existing reference-frame linear elastic
    law.  Only the element's proper polar rotation is removed.  Differentiating
    ``U`` in ``F = R U`` is important for an orthotropic law: simply rotating a
    linear nodal force omits the work of the moving frame.
    """
    rotation, stretch, stretches, directions = _polar_decomposition(deformation)
    strain = _symmetric_voigt(stretch - np.eye(3))
    stress_values = np.asarray(elasticity, dtype=float) @ strain
    material_stress = _stress_tensor(stress_values)

    # Adjoint of dU/dF in the principal-stretch basis.  The off-diagonal
    # factors retain the frame derivative when stress and stretch do not share
    # principal axes (the ordinary case for rotated orthotropy).
    local_stress = directions.T @ material_stress @ directions
    factors = 2 * stretches[:, None] / (stretches[:, None] + stretches[None, :])
    np.fill_diagonal(factors, 1.)
    first_piola = rotation @ directions @ (factors * local_stress) @ directions.T
    energy_density = float(strain @ stress_values / 2)

    # This spatial stress is work-conjugate to current area and therefore can
    # be integrated directly for a section resultant.
    spatial_stress = first_piola @ deformation.T / np.linalg.det(deformation)
    spatial_stress = (spatial_stress + spatial_stress.T) / 2
    return first_piola, energy_density, rotation, spatial_stress


def tet4_corotational_response(
    coordinates: np.ndarray, displacement: np.ndarray, elasticity: np.ndarray,
    *, consistent_tangent=True, reference_stiffness=None,
) -> tuple[np.ndarray, np.ndarray, float, np.ndarray]:
    """Objective tet4 force and consistent tangent with a small-strain law.

    The nine-component material tangent is the centered derivative of the
    exact polar-energy stress.  It is then assembled analytically with the
    constant tet shape gradients.  This avoids differentiating twelve nodal
    forces independently while retaining the rotation and geometric terms.
    """
    deformation, gradients, volume = tet4_deformation_gradient(coordinates, displacement)
    first_piola, density, rotation, spatial_stress = _tet4_corotated_stress(deformation, elasticity)
    internal = volume * np.einsum("iJ,aJ->ai", first_piola, gradients)

    if consistent_tangent:
        derivative = np.empty((3, 3, 3, 3))
        step = 2e-6 * max(1., np.linalg.norm(deformation))
        for component in range(3):
            for axis in range(3):
                perturbation = np.zeros((3, 3))
                perturbation[component, axis] = step
                plus = _tet4_corotated_stress(deformation + perturbation, elasticity)[0]
                minus = _tet4_corotated_stress(deformation - perturbation, elasticity)[0]
                derivative[:, :, component, axis] = (plus - minus) / (2 * step)
        tangent = volume * np.einsum(
            "iJjL,aJ,bL->aibj", derivative, gradients, gradients,
        ).reshape(12, 12)
    else:
        if reference_stiffness is None:
            reference_stiffness = element_matrices("tet4", coordinates, elasticity, 0.)[0]
        transform = np.kron(np.eye(4), rotation)
        tangent = transform @ reference_stiffness @ transform.T
    stress = np.array([
        spatial_stress[0, 0], spatial_stress[1, 1], spatial_stress[2, 2],
        spatial_stress[0, 1], spatial_stress[1, 2], spatial_stress[0, 2],
    ])
    return internal.ravel(), tangent, density * volume, np.tile(stress, (4, 1))


def physical_orientation_matrices(
    model, displacement: np.ndarray, orientations: np.ndarray,
) -> np.ndarray:
    """Return physical polar frames while retaining auxiliary reference frames.

    A generated tet mesh has translational physical degrees of freedom only.
    Each physical nodal frame is therefore the proper polar projection of the
    volume-weighted rotations of its incident tetrahedra.  Explicit legacy
    fixtures and generated auxiliary connector nodes keep their stored frames.
    """
    result = np.asarray(orientations, dtype=float).copy()
    physical_count = getattr(model, "physical_node_count", None)
    if physical_count is None:
        return result
    physical_count = int(physical_count)
    projected = np.zeros((physical_count, 3, 3))
    weights = np.zeros(physical_count)
    for element in model.elements:
        if element.kind != "tet4" or np.any(element.nodes >= physical_count):
            continue
        deformation, _, volume = tet4_deformation_gradient(
            model.points[element.nodes], np.asarray(displacement)[element.nodes, :3],
        )
        rotation = _polar_decomposition(deformation)[0]
        for node in element.nodes:
            projected[node] += volume * rotation
            weights[node] += volume
    for node in np.flatnonzero(weights > 0):
        left, _, right = np.linalg.svd(projected[node])
        result[node] = left @ np.diag([1., 1., np.linalg.det(left @ right)]) @ right
    return result


def physical_angular_velocities(
    model, displacement: np.ndarray, velocity: np.ndarray,
) -> np.ndarray:
    """Derive physical-node angular velocity from the exact polar rate.

    For ``F = R U``, in the principal basis of ``U`` the material spin is
    ``Omega_ij = (A_ij - A_ji) / (u_i + u_j)``, where
    ``A = R.T @ Fdot``.  It is transformed back to the spatial frame and
    volume averaged at nodes.  Auxiliary connector angular DOFs are retained.
    """
    velocity = np.asarray(velocity)
    result = velocity[:, 3:].copy()
    physical_count = getattr(model, "physical_node_count", None)
    if physical_count is None:
        return result
    physical_count = int(physical_count)
    projected = np.zeros((physical_count, 3), dtype=np.result_type(velocity, float))
    weights = np.zeros(physical_count)
    for element in model.elements:
        if element.kind != "tet4" or np.any(element.nodes >= physical_count):
            continue
        deformation, gradients, volume = tet4_deformation_gradient(
            model.points[element.nodes], np.asarray(displacement)[element.nodes, :3],
        )
        rotation, _, stretches, directions = _polar_decomposition(deformation)
        deformation_rate = velocity[element.nodes, :3].T @ gradients
        local_rate = directions.T @ rotation.T @ deformation_rate @ directions
        spin = (local_rate - local_rate.T) / (stretches[:, None] + stretches[None, :])
        spatial_spin = rotation @ directions @ spin @ directions.T @ rotation.T
        value = np.array([spatial_spin[2, 1], spatial_spin[0, 2], spatial_spin[1, 0]])
        for node in element.nodes:
            projected[node] += volume * value
            weights[node] += volume
    selected = np.flatnonzero(weights > 0)
    result[selected] = projected[selected] / weights[selected, None]
    return result


def physical_rotation_vectors(model, displacement: np.ndarray, orientations: np.ndarray, *, linear=False) -> np.ndarray:
    """Rotations on generated solid nodes, excluding auxiliary references.

    Finite responses use a volume-weighted polar-rotation projection.  Linear
    spectra use the axial vector of ``skew(grad(u))`` so modal and complex
    harmonic amplitudes remain linear.  Legacy explicit models retain their
    stored rotational degrees of freedom unchanged.
    """
    stored = rotation_log_many(orientations).astype(np.result_type(displacement, float), copy=False)
    physical_count = getattr(model, "physical_node_count", None)
    if physical_count is None:
        return stored
    physical_count = int(physical_count)
    weights = np.zeros(physical_count)
    if linear:
        projected = np.zeros((physical_count, 3), dtype=np.result_type(displacement))
    else:
        rotations = physical_orientation_matrices(model, displacement, orientations)
        stored[:physical_count] = rotation_log_many(rotations[:physical_count])
        return stored
    for element in model.elements:
        if element.kind != "tet4" or np.any(element.nodes >= physical_count):
            continue
        values = np.asarray(displacement)[element.nodes, :3]
        if linear:
            samples = integration_points("tet4", model.points[element.nodes])
            volume = float(sum(sample[2] for sample in samples))
            gradient = values.T @ samples[0][3]
            spin = (gradient - gradient.T) / 2
            value = np.array([spin[2, 1], spin[0, 2], spin[1, 0]])
        for node in element.nodes:
            projected[node] += volume * value
            weights[node] += volume
    selected = np.flatnonzero(weights > 0)
    if linear:
        stored[selected] = projected[selected] / weights[selected, None]
        return stored
    return stored


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
