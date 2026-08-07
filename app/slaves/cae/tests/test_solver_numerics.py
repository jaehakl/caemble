import numpy as np
import pytest

from app.solver_framework.models import FiniteVolumeSystem, VoxelDomain
from app.solver_framework.numerics.finite_volume import (
    create_scalar_finite_volume_system,
    solve_pcg,
)
from app.solver_framework.numerics.voxel import axis_ticks, dense_field, voxel_index


def uniform_domain():
    shape = (3, 3, 3)
    return VoxelDomain(
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


def test_voxel_axis_ticks_and_dense_field_use_axial_v_u_order():
    domain = uniform_domain()
    system = create_scalar_finite_volume_system(domain, 1.0, 0.0)
    active = np.arange(system.active_cells.size, dtype=np.float64)

    assert voxel_index(2, 1, 0, domain.shape) == 21
    assert axis_ticks(domain) == ([-1.0, 0.0, 1.0], [1.0, 0.0, -1.0], [-1.0, 0.0, 1.0])
    assert dense_field(domain, system, active).shape == (3, 3, 3)
    assert dense_field(domain, system, active)[2, 2, 1] == active[voxel_index(2, 1, 0, domain.shape)]


def test_scalar_finite_volume_matrix_is_symmetric_positive_definite():
    system = create_scalar_finite_volume_system(uniform_domain(), 1.0, 0.0)
    matrix = np.diag(system.diagonal)
    for row in range(system.active_cells.size):
        for slot, neighbor in enumerate(system.neighbors[row]):
            if neighbor >= 0:
                matrix[row, neighbor] -= system.neighbor_weights[slot]

    assert isinstance(system, FiniteVolumeSystem)
    assert np.allclose(matrix, matrix.T)
    assert np.min(np.linalg.eigvalsh(matrix)) > 0


@pytest.mark.asyncio
async def test_pcg_solves_uniform_axial_dirichlet_problem():
    progress = []

    async def report(value):
        progress.append(value)

    volume_source = np.zeros(27)
    volume_source[13] = 1.0
    system = create_scalar_finite_volume_system(uniform_domain(), 1.0, 0.0, volume_source)
    solution, iterations, residual = await solve_pcg(system, 1e-12, 100, report, "test")

    matrix = np.diag(system.diagonal)
    for row in range(system.active_cells.size):
        for slot, neighbor in enumerate(system.neighbors[row]):
            if neighbor >= 0:
                matrix[row, neighbor] -= system.neighbor_weights[slot]
    expected = np.linalg.solve(matrix, system.rhs)
    assert solution == pytest.approx(expected, abs=1e-12)
    assert iterations > 0
    assert residual <= 1e-12
    assert progress[-1]["stage"] == "solve"
