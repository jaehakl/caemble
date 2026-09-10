"""직교이방성의 물리적 방향과 Voigt 전단 약속을 독립 텐서 식으로 확인한다."""

import numpy as np
import pytest

from app.solvers.structural_mechanics.materials import isotropic_elasticity, orient_elasticity, orthotropic_elasticity
from app.solvers.structural_mechanics.rotations import rotation_exp


def test_isotropic_elasticity_is_independent_of_material_orientation():
    C = isotropic_elasticity(210e9, .3)
    Q = rotation_exp(np.array([.7, -.3, .9]))
    np.testing.assert_allclose(orient_elasticity(C, Q), C, rtol=1e-14, atol=8e-5)


def test_orthotropic_energy_is_preserved_under_arbitrary_material_rotation():
    C = orthotropic_elasticity(120e9, 8e9, 6e9, .25, .3, .2, 4e9, 3e9, 2e9)
    Q = rotation_exp(np.array([.7, -.3, .9]))
    rotated = orient_elasticity(C, Q)
    tensor = np.array([[.002, .001, -.0015], [.001, -.003, .0004], [-.0015, .0004, .001]])
    local = Q.T @ tensor @ Q
    engineering = np.r_[np.diag(tensor), 2 * tensor[0, 1], 2 * tensor[1, 2], 2 * tensor[0, 2]]
    local_engineering = np.r_[np.diag(local), 2 * local[0, 1], 2 * local[1, 2], 2 * local[0, 2]]
    np.testing.assert_allclose(engineering @ rotated @ engineering, local_engineering @ C @ local_engineering, rtol=1e-14)
    np.testing.assert_allclose(rotated, rotated.T, rtol=1e-14)
    with pytest.raises(ValueError, match="right-handed orthonormal"):
        orient_elasticity(C, np.diag([1., 1., -1.]))

