"""부가 질량을 붙여도 재료/부재의 원 감쇠 계수를 다시 맞추지 않는지 검증한다."""

import numpy as np
import pytest
from scipy import linalg

from app.solvers.structural_mechanics.beam import isotropic_beam_section
from app.solvers.structural_mechanics.formulation import prepare_matrices
from app.solvers.structural_mechanics.model import Element, StructuralModel


@pytest.mark.parametrize("attached_mass_factor", [0., 8., 99.])
def test_isolated_member_damping_does_not_retarget_loaded_frequency(attached_mass_factor):
    # 끝점의 축방향 운동 하나만 허용한 균일 보입니다. 이산화된 보 자체의
    # 유효 질량은 rho*A*L/3이며, 끝에 붙인 질량은 감쇠재료의 일부가 아닙니다.
    length, young, density, area = 2., 1200., 6., .5
    stiffness, inertia = isotropic_beam_section(young, .25, density, area, np.array([.02, .01, .01]), np.array([.4, .4]))
    bare_mass = density * area * length / 3
    axial_stiffness = young * area / length
    isolated_ratio = .04
    isolated_frequency = np.sqrt(axial_stiffness / bare_mass) / (2 * np.pi)
    beta = isolated_ratio / (np.pi * isolated_frequency)
    element = Element("beam2", np.array([0, 1]), {}, {"stiffness": stiffness, "mass": inertia, "frame": np.eye(3), "damping": beta * stiffness})
    model = StructuralModel(np.arange(2), np.array([[0., 0., 0.], [length, 0., 0.]]), [element], np.arange(12), np.setdiff1d(np.arange(12), [6]), np.zeros((2, 6)))
    model.masses.append((1, attached_mass_factor * bare_mass, np.zeros((3, 3))))
    K, M, C, _ = prepare_matrices(model)
    k, m, c = K[6, 6], M[6, 6], C[6, 6]
    np.testing.assert_allclose([k, m, c], [axial_stiffness, bare_mass * (1 + attached_mass_factor), 2 * isolated_ratio * np.sqrt(axial_stiffness * bare_mass)], rtol=2e-14)

    # 실제 조립 행렬의 상태공간 고유값에서 감쇠비를 구합니다. 복소 고유값의
    # 실수부/크기 비에는 Hz 또는 2*pi 변환이 들어가지 않습니다.
    eigenvalue = linalg.eigvals([[0., 1.], [-k / m, -c / m]])[0]
    measured_ratio = -eigenvalue.real / abs(eigenvalue)
    np.testing.assert_allclose(measured_ratio, isolated_ratio / np.sqrt(1 + attached_mass_factor), rtol=2e-14)
    if attached_mass_factor:
        assert measured_ratio < isolated_ratio
        # 부가 질량을 포함한 낮은 진동수로 beta를 다시 계산하면 원 재료의
        # 점성 계수가 커집니다. 같은 4%라는 이름이 같은 물리를 뜻하지 않습니다.
        incorrectly_retargeted_beta = 2 * isolated_ratio / np.sqrt(k / m)
        assert incorrectly_retargeted_beta > beta
