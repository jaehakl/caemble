"""MITC4 tying, 해석적 판 에너지, 적층 단면과 강체 운동 검증."""

import numpy as np
import pytest

from app.solvers.structural_mechanics.shells import (
    isotropic_section, laminate_section, shell4_geometric_stiffness,
    shell4_matrices, shell4_response,
)


RECTANGLE = np.array([[0., 0.], [2., 0.], [2., 3.], [0., 3.]])


def test_isotropic_section_matches_plate_and_rotary_inertia_formulas():
    E, nu, h, rho = 70e9, .3, .02, 2700.
    section = isotropic_section(E, nu, h, rho)
    A = E * h / (1 - nu**2) * np.array([[1., nu, 0.], [nu, 1., 0.], [0., 0., (1 - nu) / 2]])
    np.testing.assert_allclose(section["A"], A)
    np.testing.assert_allclose(section["B"], 0., atol=1e-9)
    np.testing.assert_allclose(section["D"], A * h**2 / 12)
    np.testing.assert_allclose(section["As"], np.eye(2) * 5 / 6 * E / (2 * (1 + nu)) * h)
    np.testing.assert_allclose([section["mass0"], section["mass1"], section["mass2"]], [rho*h, 0., rho*h**3/12])


def test_laminate_rotation_symmetry_and_extension_bending_coupling():
    base = {"E1": 140e9, "E2": 10e9, "nu12": .25, "G12": 5e9, "G13": 4e9, "G23": 3e9, "density": 1600., "thickness": .001}
    zero, ninety = {**base, "angle": 0.}, {**base, "angle": np.pi / 2}
    a0, a90 = laminate_section([zero])["A"], laminate_section([ninety])["A"]
    np.testing.assert_allclose(a90[0, 0], a0[1, 1])
    np.testing.assert_allclose(a90[1, 1], a0[0, 0])
    symmetric = laminate_section([zero, ninety, ninety, zero])
    np.testing.assert_allclose(symmetric["B"], 0., atol=2e-11)
    forward, reverse = laminate_section([zero, ninety]), laminate_section([ninety, zero])
    assert np.linalg.norm(forward["B"]) > 1000
    np.testing.assert_allclose(forward["B"], -reverse["B"])
    np.testing.assert_allclose(forward["A"], reverse["A"])
    np.testing.assert_allclose(forward["D"], reverse["D"])


def test_shell_affine_membrane_patch_and_analytic_energy():
    section = isotropic_section(1300., .25, .2, 7.)
    gradient = np.array([[.01, .03], [-.02, .04]])
    displacement = np.zeros((4, 6))
    displacement[:, :2] = RECTANGLE @ gradient.T + [2., -1.]
    displacement[:, 5] = .5 * (gradient[1, 0] - gradient[0, 1])
    strain = np.array([.01, .04, .01])
    K, _ = shell4_matrices(RECTANGLE, section)
    response = shell4_response(RECTANGLE, displacement, section)
    np.testing.assert_allclose(response["membraneStrain"], np.broadcast_to(strain, (4, 3)), atol=1e-15)
    np.testing.assert_allclose(response["curvature"], 0.)
    np.testing.assert_allclose(response["shearStrain"], 0.)
    np.testing.assert_allclose(displacement.ravel() @ K @ displacement.ravel(), strain @ section["A"] @ strain * 6, rtol=1e-11)


@pytest.mark.parametrize("thickness", [.2, .002])
def test_mitc_tying_reproduces_zero_shear_constant_curvature(thickness):
    section = isotropic_section(1300., .25, thickness, 7.)
    curvature = .03
    displacement = np.zeros((4, 6))
    displacement[:, 2] = .5 * curvature * RECTANGLE[:, 0]**2
    displacement[:, 4] = -curvature * RECTANGLE[:, 0]
    response = shell4_response(RECTANGLE, displacement, section)
    np.testing.assert_allclose(response["curvature"], np.broadcast_to([-curvature, 0., 0.], (4, 3)), atol=1e-16)
    np.testing.assert_allclose(response["shearStrain"], 0., atol=1e-17)
    K, _ = shell4_matrices(RECTANGLE, section)
    np.testing.assert_allclose(displacement.ravel() @ K @ displacement.ravel(), curvature**2 * section["D"][0, 0] * 6, rtol=2e-8)
    expected_surface = section["plies"][0]["elasticity"] @ np.array([-curvature * thickness / 2, 0., 0.])
    np.testing.assert_allclose(response["plyStress"][:, 0, 1], np.broadcast_to(expected_surface, (4, 3)))


def test_distorted_quad_has_constant_physical_shear_and_membrane_patch():
    coordinates = np.array([[0., 0.], [2., .1], [2.5, 2.8], [-.2, 3.]])
    section = isotropic_section(1000., .2, .1, 1.)
    displacement = np.zeros((4, 6))
    displacement[:, 2] = coordinates @ [.02, -.03]
    displacement[:, 0] = .01 * coordinates[:, 0] + .04 * coordinates[:, 1]
    displacement[:, 1] = -.02 * coordinates[:, 0] + .03 * coordinates[:, 1]
    displacement[:, 5] = -.03
    response = shell4_response(coordinates, displacement, section)
    np.testing.assert_allclose(response["shearStrain"], np.broadcast_to([.02, -.03], (4, 2)), atol=2e-17)
    np.testing.assert_allclose(response["membraneStrain"], np.broadcast_to([.01, .03, .02], (4, 3)), atol=2e-17)


def test_global_shell_rigid_motion_six_null_modes_and_mass():
    section = isotropic_section(1000., .25, .2, 7.)
    # 정규직교 basis를 이용해 xy판을 3차원에서 기울입니다.
    first = np.array([1., 2., 3.]); first /= np.linalg.norm(first)
    normal = np.cross(first, [0., 1., 0.]); normal /= np.linalg.norm(normal)
    second = np.cross(normal, first)
    coordinates = RECTANGLE @ np.array([first, second]) + [3., -2., 1.]
    K, M = shell4_matrices(coordinates, section)
    np.testing.assert_allclose(K, K.T, atol=1e-13)
    eigenvalues = np.linalg.eigvalsh(K)
    assert np.sum(np.abs(eigenvalues) < np.max(eigenvalues) * 1e-10) == 6
    for direction in np.eye(3):
        translation = np.zeros((4, 6)); translation[:, :3] = direction
        np.testing.assert_allclose(K @ translation.ravel(), 0., atol=3e-13)
        np.testing.assert_allclose(translation.ravel() @ M @ translation.ravel(), 7 * .2 * 6)
        rigid = np.zeros((4, 6)); rigid[:, :3] = np.cross(direction, coordinates); rigid[:, 3:] = direction
        np.testing.assert_allclose(K @ rigid.ravel(), 0., atol=1e-12)
    # 대각항을 인위적으로 채우지 않고 drilling축의 무질량성을 유지합니다.
    drilling = np.zeros((4, 6)); drilling[:, 3:] = normal
    np.testing.assert_allclose(M @ drilling.ravel(), 0., atol=2e-18)


@pytest.mark.parametrize("thickness", [.1, .001])
def test_thin_cantilever_end_moment_is_not_shear_locked(thickness):
    # nu=0이면 폭 방향 Poisson 구속 없이 Euler-Bernoulli의 순수 굽힘
    # 해 w(L)=M L²/(2EI)를 직접 비교할 수 있습니다.
    length, width, E, moment = 2., 1., 1e6, 1.
    coordinates = np.array([[0., 0.], [length, 0.], [length, width], [0., width]])
    section = isotropic_section(E, 0., thickness, 1.)
    K, _ = shell4_matrices(coordinates, section)
    fixed = [*range(6), *range(18, 24)]
    free = np.array([index for index in range(24) if index not in fixed])
    force = np.zeros(24); force[6 + 4] = force[12 + 4] = -moment / 2
    displacement = np.zeros(24)
    displacement[free] = np.linalg.solve(K[np.ix_(free, free)], force[free])
    rigidity = E * width * thickness**3 / 12
    np.testing.assert_allclose(displacement[[8, 14]], moment * length**2 / (2 * rigidity), rtol=3e-8)
    np.testing.assert_allclose(displacement[[10, 16]], -moment * length / rigidity, rtol=3e-8)


def test_membrane_prestress_has_plate_buckling_energy_sign():
    displacement = np.zeros((4, 6)); displacement[:, 2] = .3 * RECTANGLE[:, 0]
    Kg = shell4_geometric_stiffness(RECTANGLE, np.array([-20., 0., 0.]))
    np.testing.assert_allclose(displacement.ravel() @ Kg @ displacement.ravel(), -20 * .3**2 * 6)


def test_unsymmetric_density_retains_translation_rotation_mass_coupling():
    base = {"E1": 1000., "E2": 1000., "nu12": .25, "G12": 400., "G13": 400., "G23": 400., "thickness": .1}
    section = laminate_section([{**base, "density": 1.}, {**base, "density": 3.}])
    np.testing.assert_allclose(section["mass1"], .01)
    _, M = shell4_matrices(RECTANGLE, section)
    translation, rotation = np.zeros((4, 6)), np.zeros((4, 6))
    translation[:, 0] = 1.; rotation[:, 4] = 1.
    np.testing.assert_allclose(translation.ravel() @ M @ rotation.ravel(), .01 * 6)
