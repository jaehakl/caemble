from __future__ import annotations

import numpy as np
import pytest

from app.methods.coupling import (
    project_structured_to_unstructured_cell_field_conservative,
    project_unstructured_to_structured_cell_field_conservative,
)
from app.methods.mesh import UnstructuredMesh
from app.methods.structured import VoxelDomain, structured_cell_field, structured_grid_ref


def _structured_domain_ref(shape: tuple[int, int, int]) -> dict[str, object]:
    domain = VoxelDomain(
        shape=shape,
        axis=np.asarray([1.0, 0.0, 0.0]),
        length=2.0,
        minimum_u=-0.5,
        minimum_v=-0.5,
        axial_spacing=2.0 / shape[0],
        u_spacing=1.0 / shape[1],
        v_spacing=1.0 / shape[2],
        occupancy=np.ones(np.prod(shape), dtype=np.uint8),
        occupied_count=int(np.prod(shape)),
    )
    return structured_grid_ref(
        domain,
        geometry_hashes=["geometry"],
        root_ids=["part"],
        reference_length_unit="m",
    )


def _two_hexahedra() -> UnstructuredMesh:
    points = np.asarray(
        [
            [-1.0, -0.5, -0.5],
            [0.0, -0.5, -0.5],
            [-1.0, 0.5, -0.5],
            [0.0, 0.5, -0.5],
            [-1.0, -0.5, 0.5],
            [0.0, -0.5, 0.5],
            [-1.0, 0.5, 0.5],
            [0.0, 0.5, 0.5],
            [1.0, -0.5, -0.5],
            [1.0, 0.5, -0.5],
            [1.0, -0.5, 0.5],
            [1.0, 0.5, 0.5],
        ]
    )
    cells = np.asarray(
        [
            [0, 1, 2, 3, 4, 5, 6, 7],
            [1, 8, 3, 9, 5, 10, 7, 11],
        ]
    )
    return UnstructuredMesh(points, cells, cell_type="axis-aligned-hexahedron")


def test_structured_to_unstructured_projection_preserves_integral() -> None:
    domain_ref = _structured_domain_ref((4, 1, 1))
    values = np.asarray([[[2.0]], [[2.0]], [[4.0]], [[4.0]]])
    field = structured_cell_field(
        domain_ref,
        values,
        domain_ref["axes"],
        quantity_kind="PowerDensity",
        unit="W.m-3",
    )

    projected = project_structured_to_unstructured_cell_field_conservative(
        field,
        _two_hexahedra(),
        target_length_unit="m",
    )

    np.testing.assert_allclose(projected, [2.0, 4.0])
    source_integral = float(np.sum(values) * 0.5)
    target_integral = float(np.sum(projected) * 1.0)
    assert target_integral == pytest.approx(source_integral)


def test_unstructured_to_structured_projection_preserves_integral() -> None:
    domain_ref = _structured_domain_ref((4, 1, 1))
    values = np.asarray([2.0, 4.0])

    projected = project_unstructured_to_structured_cell_field_conservative(
        values,
        _two_hexahedra(),
        domain_ref,
        source_length_unit="m",
    )

    np.testing.assert_allclose(projected[:, 0, 0], [2.0, 2.0, 4.0, 4.0])
    source_integral = float(np.sum(values) * 1.0)
    target_integral = float(np.sum(projected) * 0.5)
    assert target_integral == pytest.approx(source_integral)


def test_projection_rejects_general_unstructured_cells() -> None:
    domain_ref = _structured_domain_ref((1, 1, 1))
    tetrahedron = UnstructuredMesh(
        np.asarray(
            [[0.0, -0.5, -0.5], [2.0, -0.5, -0.5], [0.0, 0.5, -0.5], [0.0, -0.5, 0.5]]
        ),
        np.asarray([[0, 1, 2, 3]]),
        cell_type="tetrahedron",
    )

    with pytest.raises(ValueError, match="axis-aligned orthotopes"):
        project_unstructured_to_structured_cell_field_conservative(
            np.asarray([1.0]),
            tetrahedron,
            domain_ref,
            source_length_unit="m",
        )


def test_projection_rejects_non_matching_support() -> None:
    domain_ref = _structured_domain_ref((4, 1, 1))
    mesh = _two_hexahedra()
    shifted = UnstructuredMesh(mesh.points + np.asarray([0.25, 0.0, 0.0]), mesh.cells)

    with pytest.raises(ValueError, match="same region"):
        project_unstructured_to_structured_cell_field_conservative(
            np.asarray([2.0, 4.0]),
            shifted,
            domain_ref,
            source_length_unit="m",
        )
