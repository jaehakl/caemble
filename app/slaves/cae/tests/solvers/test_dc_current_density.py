import numpy as np
import pytest

from app.solver_framework.models import VoxelDomain
from app.solver_framework.numerics.finite_volume import create_scalar_finite_volume_system
from app.solvers.dc_current_density.solver import _cross_section, _gradient


def test_dc_cross_section_and_gradient_are_solver_owned():
    shape = (3, 3, 3)
    domain = VoxelDomain(
        shape,
        np.array([1.0, 0.0, 0.0]),
        3.0,
        -1.5,
        -1.5,
        1.0,
        1.0,
        1.0,
        np.ones(np.prod(shape), dtype=np.uint8),
        np.prod(shape),
    )
    system = create_scalar_finite_volume_system(domain, 1.0, 0.0)
    solution = np.repeat([5 / 6, 1 / 2, 1 / 6], 9)

    density, total = _cross_section(solution, system, domain, 0.5, 2.0, 1.0, 0.0, True)
    gradient = _gradient(domain, system, solution, 13, 1.0, 0.0)

    assert density == pytest.approx(np.full((3, 3), 2 / 3))
    assert total == pytest.approx(6.0)
    assert gradient == pytest.approx([-1 / 3, 0.0, 0.0])
