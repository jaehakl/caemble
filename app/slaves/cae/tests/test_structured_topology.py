from __future__ import annotations

import asyncio

import numpy as np
import pytest

from app.methods.geometry import TriangularMesh
from app.methods.structured import (
    AxisSegment,
    RectilinearTopology,
    rasterize_mesh_cell_centers,
)
from tests.versioned_solver_fixtures import cube_mesh


def test_cartesian_blocks_expose_bounds_tags_and_global_slices() -> None:
    topology = RectilinearTopology(
        axes=(
            (
                AxisSegment(-2.0, -1.0, 1, "pml"),
                AxisSegment(-1.0, 0.0, 2, "buffer"),
                AxisSegment(0.0, 2.0, 4, "main"),
            ),
            (
                AxisSegment(-1.0, 1.0, 2, "main"),
                AxisSegment(1.0, 2.0, 1, "pml"),
            ),
            (AxisSegment(0.0, 3.0, 3, "main"),),
        )
    )

    assert len(topology.blocks) == 6
    assert topology.global_shape == (7, 3, 3)
    assert topology.bounds == ((-2.0, 2.0), (-1.0, 2.0), (0.0, 3.0))
    block = topology.block((1, 0, 0))
    assert block.bounds == ((-1.0, 0.0), (-1.0, 1.0), (0.0, 3.0))
    assert block.shape == (2, 2, 3)
    assert block.cell_sizes == (0.5, 1.0, 1.0)
    assert block.global_slices == (slice(1, 3), slice(0, 2), slice(0, 3))
    assert block.tags == frozenset({"buffer", "main"})


def test_piecewise_ticks_preserve_segment_cell_sizes() -> None:
    topology = RectilinearTopology(
        axes=(
            (
                AxisSegment(-2.0, 0.0, 1, "buffer"),
                AxisSegment(0.0, 1.0, 2, "main"),
                AxisSegment(1.0, 4.0, 1, "pml"),
            ),
        )
    )

    assert topology.boundary_ticks(0) == (-2.0, 0.0, 0.5, 1.0, 4.0)
    assert topology.cell_ticks(0) == (-1.0, 0.25, 0.75, 2.5)


def test_face_neighbors_keep_identical_tangential_slices() -> None:
    topology = RectilinearTopology(
        axes=(
            (AxisSegment(-1.0, 0.0, 1, "buffer"), AxisSegment(0.0, 2.0, 4, "main")),
            (AxisSegment(-2.0, 0.0, 2, "buffer"), AxisSegment(0.0, 1.0, 2, "main")),
            (AxisSegment(0.0, 3.0, 3, "main"),),
        )
    )

    for block in topology.blocks:
        for offset, neighbor_index in block.neighbors.items():
            normal_axis = next(axis for axis, component in enumerate(offset) if component)
            neighbor = topology.block(neighbor_index)
            for axis in range(topology.ndim):
                if axis != normal_axis:
                    assert neighbor.global_slices[axis] == block.global_slices[axis]
                    assert neighbor.cell_sizes[axis] == block.cell_sizes[axis]


def test_periodic_axis_wraps_end_blocks_without_wrapping_other_axes() -> None:
    topology = RectilinearTopology(
        axes=(
            (AxisSegment(0.0, 1.0, 1), AxisSegment(1.0, 2.0, 1)),
            (AxisSegment(0.0, 1.0, 1),),
        ),
        periodic=(True, False),
    )

    assert topology.block((0, 0)).neighbors[(-1, 0)] == (1, 0)
    assert topology.block((1, 0)).neighbors[(1, 0)] == (0, 0)
    assert (0, -1) not in topology.block((0, 0)).neighbors
    assert (0, 1) not in topology.block((0, 0)).neighbors


def test_topology_rejects_noncontiguous_axis_segments() -> None:
    with pytest.raises(ValueError, match="contiguous"):
        RectilinearTopology(
            axes=((AxisSegment(0.0, 1.0, 1), AxisSegment(2.0, 3.0, 1)),)
        )


def test_mesh_rasterization_returns_piecewise_grid_cell_center_mask() -> None:
    progress_events: list[object] = []

    async def progress(event: object) -> None:
        progress_events.append(event)

    mask = asyncio.run(
        rasterize_mesh_cell_centers(
            cube_mesh(),
            (-0.25, 0.25, 0.75, 1.25),
            (-0.25, 0.25, 0.75, 1.25),
            (-0.25, 0.25, 0.75, 1.25),
            progress,
        )
    )

    expected = np.zeros((4, 4, 4), dtype=np.bool_)
    expected[1:3, 1:3, 1:3] = True
    np.testing.assert_array_equal(mask, expected)
    assert progress_events[-1] == {
        "stage": "structured-rasterization",
        "completed": 16,
        "total": 16,
    }


def test_mesh_rasterization_is_scale_independent_for_si_micrometer_geometry() -> None:
    mesh = cube_mesh()
    micrometer_mesh = TriangularMesh(
        mesh.vertices * 1e-6,
        mesh.triangles,
        mesh.triangle_provenance,
    )
    ticks = tuple(value * 1e-6 for value in (-0.25, 0.25, 0.75, 1.25))

    mask = asyncio.run(
        rasterize_mesh_cell_centers(
            micrometer_mesh,
            ticks,
            ticks,
            ticks,
        )
    )

    expected = np.zeros((4, 4, 4), dtype=np.bool_)
    expected[1:3, 1:3, 1:3] = True
    np.testing.assert_array_equal(mask, expected)
