"""선형 3차원 체적 요소를 정확한 순수 굽힘 경계값 문제와 비교합니다."""

import numpy as np
import pytest

from app.solvers.structural_mechanics.analysis import static_analysis
from app.solvers.structural_mechanics.formulation import prepare_matrices
from app.solvers.structural_mechanics.materials import isotropic_elasticity
from app.solvers.structural_mechanics.meshing import brick_mesh
from app.solvers.structural_mechanics.model import Element, StructuralModel


def pure_bending_solid(kind, refinement):
    """끝면의 선형 응력을 일관 절점 하중으로 적분한 실제 3D 모델입니다.

    ν=0이면 ux=−κxz, uy=0, uz=κx²/2가 3D 탄성 방정식의 정확한 해입니다.
    따라서 x=0의 모든 변위를 고정해도 별도 경계층이 생기지 않습니다.
    끝면에는 σxx=−Eκz를 가하고 네 옆면은 자유면입니다. x=0의 지지면은
    굽힘모멘트를 평형시키는 반력을 받습니다.
    점 모멘트나 보의 회전 자유도를 쓰지 않고 이 표면 traction을 적분합니다.
    """
    length, width, height, young, moment = 2., .25, 1., 1.e6, 1.
    points, bricks = brick_mesh([0., -width / 2, -height / 2], [length, width, height], [2 * refinement, 2, refinement])
    inertia = width * height**3 / 12
    if kind == "tet4":
        # 공통 body diagonal을 갖는 여섯 양의 체적 사면체입니다.
        # 인접 brick의 공통 면 삼각분할도 일치하므로 hanging node가 없습니다.
        split = np.array([[0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6],
                          [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6]])
        cells = bricks[:, split].reshape(-1, 4)
        face_slots = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]
    else:
        cells = bricks
        face_slots = [[1, 2, 6, 5]]
    material = {"model": "mechanics.isotropic-elastic@1", "E": young,
                "nu": 0., "density": 1., "C": isotropic_elasticity(young, 0.)}
    elements = [Element(kind, nodes, material, {}) for nodes in cells]
    dofs = (6 * np.arange(len(points))[:, None] + np.arange(3)).ravel()
    fixed = (6 * np.flatnonzero(points[:, 0] == 0.)[:, None] + np.arange(3)).ravel()
    force = np.zeros((len(points), 6))
    for nodes in cells:
        for slots in face_slots:
            face = nodes[slots]
            xyz = points[face]
            if not np.all(xyz[:, 0] == length):
                continue
            traction = -moment * xyz[:, 2] / inertia
            if kind == "tet4":
                area = np.linalg.norm(np.cross(xyz[1] - xyz[0], xyz[2] - xyz[0])) / 2
                surface_mass = area / 12 * (np.ones((3, 3)) + np.eye(3))
            else:
                area = np.linalg.norm(np.cross(xyz[1] - xyz[0], xyz[3] - xyz[0]))
                surface_mass = area / 36 * np.array([[4, 2, 1, 2], [2, 4, 2, 1],
                                                     [1, 2, 4, 2], [2, 1, 2, 4]])
            np.add.at(force[:, 0], face, surface_mass @ traction)
    model = StructuralModel(np.arange(len(points)), points, elements, dofs, fixed, force)
    return model, moment * length**2 / (2 * young * inertia), moment


@pytest.mark.parametrize("kind", ["tet4", "hex8"])
def test_solid_pure_moment_cantilever_converges_to_exact_three_dimensional_elasticity(kind, record_property):
    errors = []
    for refinement in (4, 10, 20):
        model, exact_tip, moment = pure_bending_solid(kind, refinement)
        stiffness, mass, _, prepared = prepare_matrices(model)
        result = static_analysis(model, prepared, stiffness, mass)
        tip = np.flatnonzero(np.isclose(model.points[:, 0], 2.) &
                             np.isclose(model.points[:, 1], 0.) &
                             np.isclose(model.points[:, 2], 0.))[0]
        errors.append(abs(result.displacement[tip, 2] / exact_tip - 1))
        # 합력이 0인 순수 모멘트 하중이며 지지 반력이 그 모멘트를 받아야 합니다.
        np.testing.assert_allclose(model.force[:, :3].sum(axis=0), 0., atol=1e-12)
        applied_moment = np.cross(model.points, model.force[:, :3]).sum(axis=0)
        support_moment = np.cross(model.points, result.reaction[:, :3]).sum(axis=0)
        np.testing.assert_allclose(applied_moment, [0., -moment, 0.], atol=1e-12)
        np.testing.assert_allclose(support_moment, -applied_moment, atol=2e-9)
        np.testing.assert_allclose(result.reaction[:, :3].sum(axis=0), 0., atol=2e-9)
    assert errors[2] < errors[1] < errors[0], errors
    assert errors[-1] < .01, errors
    record_property("relative_tip_errors", errors)
