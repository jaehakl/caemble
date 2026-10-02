"""해석해·에너지·유한차분으로 재료와 연속체 요소를 검증합니다."""

import numpy as np
import pytest

from app.solvers.structural_mechanics.materials import (
    isotropic_elasticity, j2_return, orthotropic_elasticity,
)
from app.solvers.structural_mechanics.continuum import (
    element_matrices, element_nonlinear_response, element_response,
    geometric_stiffness, integration_points, plane_elasticity,
)


ELEMENTS = {
    "tri3": (np.array([[0., 0.], [2., 0.], [0., 3.]]), 3.),
    "quad4": (np.array([[0., 0.], [2., 0.], [2., 3.], [0., 3.]]), 6.),
    "tet4": (np.array([[0., 0., 0.], [2., 0., 0.], [0., 3., 0.], [0., 0., 4.]]), 4.),
    "hex8": (np.array([
        [0., 0., 0.], [2., 0., 0.], [2., 3., 0.], [0., 3., 0.],
        [0., 0., 4.], [2., 0., 4.], [2., 3., 4.], [0., 3., 4.],
    ]), 24.),
}


def test_isotropic_uniaxial_stress_and_orthotropic_isotropic_limit():
    E, nu, sigma = 210e9, 0.29, 87e6
    C = isotropic_elasticity(E, nu)
    strain = sigma / E * np.array([1., -nu, -nu, 0., 0., 0.])
    np.testing.assert_allclose(C @ strain, [sigma, 0., 0., 0., 0., 0.], atol=1e-8)
    G = E / (2 * (1 + nu))
    np.testing.assert_allclose(orthotropic_elasticity(E, E, E, nu, nu, nu, G, G, G), C, rtol=2e-15)


def test_orthotropic_reciprocity_and_positive_energy():
    C = orthotropic_elasticity(140e9, 10e9, 8e9, .25, .3, .22, 5e9, 3e9, 4e9)
    S = np.linalg.inv(C)
    np.testing.assert_allclose(S[0, 1], -.25 / 140e9)
    np.testing.assert_allclose(S, S.T, atol=1e-25)
    assert np.min(np.linalg.eigvalsh(C)) > 0
    with pytest.raises(ValueError, match="positive elastic energy"):
        orthotropic_elasticity(1., 1., 1., .9, .9, .9, .2, .2, .2)


def test_plane_stress_and_plane_strain_are_different_physical_constraints():
    E, nu = 1200., .3
    C = isotropic_elasticity(E, nu)
    expected = E / (1 - nu**2) * np.array([[1., nu, 0.], [nu, 1., 0.], [0., 0., (1 - nu) / 2]])
    np.testing.assert_allclose(plane_elasticity(C, "stress"), expected)
    np.testing.assert_allclose(plane_elasticity(C, "strain"), C[np.ix_([0, 1, 3], [0, 1, 3])])
    assert plane_elasticity(C, "strain")[0, 0] > expected[0, 0]


@pytest.mark.parametrize("kind", ELEMENTS)
def test_element_affine_patch_rigid_modes_consistent_mass_and_energy(kind):
    coordinates, volume = ELEMENTS[kind]
    dimension = coordinates.shape[1]
    # 회전/비정사각형 좌표에서도 물리적 선형 변위장을 정확히 재현해야 합니다.
    transform = np.array([[1., .2, -.1], [.1, .9, .15], [.05, -.1, 1.1]])[:dimension, :dimension]
    coordinates = coordinates @ transform.T + .7
    volume *= np.linalg.det(transform)
    thickness, density = .4, 7.
    if dimension == 2:
        volume *= thickness
    C = isotropic_elasticity(1700., .27)
    K, M = element_matrices(kind, coordinates, C, density, thickness)
    gradient = np.array([[.01, .03, -.02], [.02, -.01, .04], [.01, .02, .03]])[:dimension, :dimension]
    displacement = (coordinates @ gradient.T + np.arange(dimension)).reshape(-1)
    if dimension == 2:
        strain = np.array([gradient[0, 0], gradient[1, 1], gradient[0, 1] + gradient[1, 0]])
        constitutive = plane_elasticity(C)
    else:
        strain = np.array([gradient[0, 0], gradient[1, 1], gradient[2, 2],
                           gradient[0, 1] + gradient[1, 0], gradient[1, 2] + gradient[2, 1],
                           gradient[0, 2] + gradient[2, 0]])
        constitutive = C
    strains, stresses = element_response(kind, coordinates, displacement, C, thickness)
    np.testing.assert_allclose(strains, np.broadcast_to(strain, strains.shape), atol=2e-15)
    np.testing.assert_allclose(stresses, np.broadcast_to(constitutive @ strain, stresses.shape), atol=4e-12)
    np.testing.assert_allclose(displacement @ K @ displacement, strain @ constitutive @ strain * volume, rtol=2e-11)
    np.testing.assert_allclose(K, K.T, atol=1e-12)
    assert np.min(np.linalg.eigvalsh(M)) > 0
    for axis in range(dimension):
        translation = np.zeros(coordinates.size)
        translation[axis::dimension] = 1
        np.testing.assert_allclose(K @ translation, 0., atol=2e-12)
        np.testing.assert_allclose(translation @ M @ translation, density * volume, rtol=2e-15)
    spin = np.array([[0., -.2, .3], [.2, 0., -.1], [-.3, .1, 0.]])[:dimension, :dimension]
    np.testing.assert_allclose(K @ (coordinates @ spin.T).reshape(-1), 0., atol=4e-12)


@pytest.mark.parametrize("kind", ELEMENTS)
def test_geometric_stiffness_has_correct_prestress_energy_and_sign(kind):
    coordinates, volume = ELEMENTS[kind]
    dimension = coordinates.shape[1]
    stress = np.zeros(3 if dimension == 2 else 6)
    stress[0] = -23.
    displacement = np.zeros_like(coordinates)
    displacement[:, -1] = .7 * coordinates[:, 0]
    Kg = geometric_stiffness(kind, coordinates, stress)
    np.testing.assert_allclose(displacement.ravel() @ Kg @ displacement.ravel(), -23 * .7**2 * volume)
    np.testing.assert_allclose(Kg, Kg.T, atol=1e-14)


@pytest.mark.parametrize("kind", ELEMENTS)
def test_inverted_elements_are_rejected(kind):
    coordinates, _ = ELEMENTS[kind]
    reflected = coordinates.copy()
    reflected[:, 0] *= -1
    with pytest.raises(ValueError, match="inverted or degenerate"):
        integration_points(kind, reflected)


def test_j2_return_yield_condition_unloading_and_history_immutability():
    E, nu, yield_stress, H = 210e9, .3, 250e6, 2e9
    strain = np.array([.004, -.001, -.001, .003, .001, -.0005])
    previous = np.zeros(6)
    stress, tangent, plastic, equivalent = j2_return(strain, previous, 0., E, nu, yield_stress, H)
    deviator = stress.copy()
    deviator[:3] -= np.mean(stress[:3])
    q = np.sqrt(1.5 * np.dot(deviator * [1, 1, 1, 2, 2, 2], deviator))
    np.testing.assert_allclose(q, yield_stress + H * equivalent, rtol=2e-15)
    np.testing.assert_allclose(np.sum(plastic[:3]), 0., atol=1e-18)
    assert equivalent > 0 and stress @ plastic > 0
    np.testing.assert_array_equal(previous, np.zeros(6))
    np.testing.assert_allclose(tangent, tangent.T, atol=3e-5)
    unloaded, _, plastic_after, equivalent_after = j2_return(plastic, plastic, equivalent, E, nu, yield_stress, H)
    np.testing.assert_allclose(unloaded, 0.)
    np.testing.assert_array_equal(plastic_after, plastic)
    assert equivalent_after == equivalent


@pytest.mark.parametrize("hardening", [0., 2e9])
def test_j2_consistent_tangent_matches_return_mapping_finite_difference(hardening):
    strain = np.array([.005, -.001, -.002, .002, -.001, .0007])
    history = np.array([.0001, -.00005, -.00005, .0002, 0., 0.])
    arguments = (history, .0003, 210e9, .3, 250e6, hardening)
    _, tangent, _, _ = j2_return(strain, *arguments)
    numerical = np.empty((6, 6))
    step = 1e-8
    for column in range(6):
        increment = np.eye(6)[column] * step
        numerical[:, column] = (j2_return(strain + increment, *arguments)[0] - j2_return(strain - increment, *arguments)[0]) / (2 * step)
    np.testing.assert_allclose(tangent, numerical, rtol=2e-8, atol=8.)


@pytest.mark.parametrize("kind", ["tet4", "hex8"])
def test_solid_plastic_internal_force_tangent_and_trial_rollback(kind):
    coordinates, _ = ELEMENTS[kind]
    deformation = np.diag([.006, -.001, -.002])
    displacement = (coordinates @ deformation).ravel()
    material = {"E": 210e9, "nu": .3, "yieldStress": 250e6, "hardening": 1e9}
    count = len(integration_points(kind, coordinates))
    committed = {"plasticStrain": np.zeros((count, 6)), "equivalentPlasticStrain": np.zeros(count)}
    force, tangent, trial, _ = element_nonlinear_response(kind, coordinates, displacement, material, committed)
    assert np.min(trial["equivalentPlasticStrain"]) > 0
    np.testing.assert_array_equal(committed["plasticStrain"], 0.)
    np.testing.assert_array_equal(committed["equivalentPlasticStrain"], 0.)
    np.testing.assert_allclose(force.reshape(-1, 3).sum(axis=0), 0., atol=1e-6)
    direction = np.random.default_rng(21).normal(size=displacement.size)
    step = 1e-8
    plus = element_nonlinear_response(kind, coordinates, displacement + step * direction, material, committed)[0]
    minus = element_nonlinear_response(kind, coordinates, displacement - step * direction, material, committed)[0]
    np.testing.assert_allclose(tangent @ direction, (plus - minus) / (2 * step), rtol=3e-8, atol=20.)
    # 같은 확정 상태에서 재시도하면 같은 trial이 나와야 합니다.
    repeated = element_nonlinear_response(kind, coordinates, displacement, material, committed)
    np.testing.assert_array_equal(repeated[0], force)
    np.testing.assert_array_equal(repeated[2]["plasticStrain"], trial["plasticStrain"])
