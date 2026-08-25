import numpy as np
import pytest

from app.errors import CaeError
from app.solver_framework.geometry import TriangleProvenance, TriangularMesh
from app.solver_framework.models import VoxelDomain
from app.solver_framework.numerics.finite_volume import create_scalar_finite_volume_system, solve_pcg
from app.solver_framework.numerics.voxel import build_electrode_voxel_domain
from app.solvers.dc_current_density.solver import _cross_section, _gradient


def box_part(part_id, minimum, maximum):
    x0, y0, z0 = minimum
    x1, y1, z1 = maximum
    vertices = np.asarray(
        [
            [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
            [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
        ],
        dtype=np.float64,
    )
    triangles = np.asarray(
        [
            [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
            [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
            [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
        ],
        dtype=np.int64,
    )
    provenance = (TriangleProvenance(part_id, part_id, "Outer"),) * len(triangles)
    return TriangularMesh(vertices, triangles, provenance)


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
    solution = np.repeat([5 / 6, 1 / 2, 1 / 6], 9)

    density, total = _cross_section(solution, domain, 0.5, 2.0, 1.0, 0.0, True, True)
    gradient = _gradient(domain, solution, 13, 1.0, 0.0, True)

    assert density == pytest.approx(np.full((3, 3), 2 / 3))
    assert total == pytest.approx(6.0)
    assert gradient == pytest.approx([-1 / 3, 0.0, 0.0])


@pytest.mark.asyncio
async def test_dc_fixed_electrode_cells_are_excluded_from_the_solve():
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
    fixed = np.full(np.prod(shape), np.nan)
    fixed[:9] = 1.0
    fixed[-9:] = 0.0
    system = create_scalar_finite_volume_system(domain, 1.0, 0.0, fixed_values=fixed)

    async def progress(_value):
        return None

    solution, _iterations, residual = await solve_pcg(system, 1e-12, 100, progress, "DC test")

    assert system.active_cells.tolist() == list(range(9, 18))
    assert solution == pytest.approx(np.full(9, 0.5))
    assert residual <= 1e-12


@pytest.mark.asyncio
async def test_dc_voxelizes_touching_experiment_and_task_geometry_as_one_domain():
    conductor = box_part("conductor", [-0.5, -0.5, -1.0], [0.5, 0.5, 1.0])
    source = box_part("source", [-0.5, -0.5, -1.5], [0.5, 0.5, -1.0])
    reference = box_part("reference", [-0.5, -0.5, 1.0], [0.5, 0.5, 1.5])

    async def progress(_value):
        return None

    result = await build_electrode_voxel_domain(
        [conductor],
        [source],
        [reference],
        (12, 5, 5),
        progress,
        "DC test",
    )

    assert result.domain.occupied_count == 12 * 5 * 5
    assert np.count_nonzero(result.conductor) == 8 * 5 * 5
    assert np.count_nonzero(result.source_electrode) == 2 * 5 * 5
    assert np.count_nonzero(result.reference_electrode) == 2 * 5 * 5


@pytest.mark.parametrize(
    ("source_bounds", "reference_bounds", "message"),
    [
        (
            ([-0.5, -0.5, -2.0], [0.5, 0.5, -1.5]),
            ([-0.5, -0.5, 1.0], [0.5, 0.5, 1.5]),
            "source electrode must contact",
        ),
        (
            ([-0.5, -0.5, -1.5], [0.5, 0.5, -0.5]),
            ([-0.5, -0.5, -0.75], [0.5, 0.5, 0.25]),
            "must not overlap",
        ),
    ],
)
@pytest.mark.asyncio
async def test_dc_rejects_disconnected_or_overlapping_electrodes(source_bounds, reference_bounds, message):
    conductor = box_part("conductor", [-0.5, -0.5, -1.0], [0.5, 0.5, 1.0])
    source = box_part("source", *source_bounds)
    reference = box_part("reference", *reference_bounds)

    async def progress(_value):
        return None

    with pytest.raises(CaeError, match=message):
        await build_electrode_voxel_domain(
            [conductor],
            [source],
            [reference],
            (20, 5, 5),
            progress,
            "DC test",
        )
