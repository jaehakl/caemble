"""편심 단면의 중력은 회전하는 실제 무게중심의 퍼텐셜과 일치해야 한다."""

import numpy as np
from scipy import optimize, sparse

from app.solvers.structural_mechanics.analysis import (
    initial_solution,
    initialize_acceleration,
    static_analysis,
)
from app.solvers.structural_mechanics.constraints import (
    constraint_transform,
    enforce_links,
)
from app.solvers.structural_mechanics.formulation import (
    inertial_response,
    prepare_matrices,
)
from app.solvers.structural_mechanics.model import Element, StructuralModel
from app.solvers.structural_mechanics.rotations import rotation_exp, skew


def eccentric_beam():
    points = np.array([[0., 0., 0.], [2., 0., 0.]])
    center = np.array([0., .25, 0.])
    mass_per_length = 2.
    cross_mass = mass_per_length * skew(center)
    # v_CG=v_reference+omega×center에서 얻는 운동에너지의 정확한 6×6 행렬.
    inertia = .2 * np.eye(3) + mass_per_length * (np.dot(center, center) * np.eye(3) - np.outer(center, center))
    section = {"stiffness": np.diag([1000., 500., 500., 200., 200., 200.]), "mass": np.block([[mass_per_length * np.eye(3), -cross_mass], [cross_mass, inertia]]), "frame": np.eye(3)}
    element = Element("beam2", np.array([0, 1]), {"model": "mechanics.isotropic-elastic@1"}, section)
    # 기준선은 x축에 놓고 두 끝의 자세를 강체 연결한다. x회전만 스프링이 지지한다.
    model = StructuralModel(np.arange(2), points, [element], np.arange(12), np.array([0, 1, 2, 4, 5]), np.zeros((2, 6)))
    model.links = [(0, 1, np.arange(6))]
    model.springs = [(3, -1, 1., 10., 0.)]
    model.gravity = np.array([0., 0., -10.])
    return model


def test_rotated_section_gravity_matches_center_of_mass_potential_and_exact_tangent():
    model = eccentric_beam()
    _, mass, _, prepared = prepare_matrices(model)
    state = initial_solution(model)
    theta = -.8
    state.displacement[0, 3] = theta
    state.orientations[0] = rotation_exp([theta, 0., 0.])
    enforce_links(model, state.displacement, state.orientations)
    acceleration = np.tile(np.r_[model.gravity, np.zeros(3)], (2, 1))
    force, _, tangent, _, _ = inertial_response(model, state.displacement, state.orientations, state.velocity, acceleration, prepared, mass, True, derivatives=True)
    T = constraint_transform(model, state.orientations)
    # U_g=mg*z_CG=4*10*.25*sin(theta), 따라서 Q_g=-dU_g/dtheta.
    np.testing.assert_allclose(T.T @ force, [-10. * np.cos(theta)], atol=2e-13)
    step = 1e-6
    potential_gradient = (10. * np.sin(theta + step) - 10. * np.sin(theta - step)) / (2 * step)
    np.testing.assert_allclose(T.T @ force, [-potential_gradient], atol=2e-9)
    # x축 위 기준선은 roll에 따라 이동하지 않으므로 이 경우 T도 일정하다.
    np.testing.assert_allclose((T.T @ tangent @ T).toarray(), [[10. * np.sin(theta)]], atol=2e-13)


def test_static_rotating_gravity_equilibrium_and_added_mass_have_no_fictitious_weight():
    model = eccentric_beam()
    stiffness, mass, damping, prepared = prepare_matrices(model)
    result = static_analysis(model, prepared, stiffness, mass, tolerance=1e-11, geometric=True)
    # k*theta+mg*e*cos(theta)=0의 독립된 1변수 해: 기준 자세 중력만 쓰면 -1 rad가 된다.
    expected = optimize.brentq(lambda angle: angle + np.cos(angle), -1., 0.)
    np.testing.assert_allclose(result.displacement[0, 3], expected, atol=2e-11)
    np.testing.assert_allclose(result.reaction[0], [0., 0., 40., 0., -40., 0.], atol=2e-10)
    np.testing.assert_allclose(result.reaction[1], 0., atol=2e-10)
    # 유체 부가질량은 관성만 증가시킨다. 평형점에서 부가질량을 더해도
    # 초기 가속도나 지지 반력이 생겨서는 안 된다.
    added = np.tile([5., 5., 5., 0., 0., 0.], 2)
    external = mass @ np.tile(np.r_[model.gravity, np.zeros(3)], 2)
    initialized = initialize_acceleration(model, result, prepared, stiffness, mass + sparse.diags(added), damping, external, True)
    np.testing.assert_allclose(initialized.acceleration, 0., atol=3e-10)
    np.testing.assert_allclose(initialized.reaction, result.reaction, atol=3e-10)
