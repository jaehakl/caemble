from __future__ import annotations

from dataclasses import replace

import numpy as np
import pytest

from app.methods.coupling import (
    project_orthotope_scalar_cell_averages_to_structured,
    project_structured_scalar_cell_averages,
    project_structured_scalar_cell_averages_to_orthotopes,
)
from app.runtime_kernel.api import FieldValue, StructuredGridValue, UnstructuredMeshValue


def test_same_structured_domain_keeps_array_dtype_and_metadata() -> None:
    domain = StructuredGridValue((2,), (np.array([0.5, 1.5]),), "m", "grid")
    values = np.array([2.0, 4.0], dtype=np.float32)
    field = FieldValue(domain, "cell", "PowerDensity", "W.m-3", values, metadata={"step": 1})

    result = project_structured_scalar_cell_averages(field, replace(domain))

    assert result.values is values
    assert result.values.dtype == np.float32
    assert result.metadata is field.metadata
    assert result.quantity_kind == field.quantity_kind
    assert result.unit == field.unit


def test_structured_projection_requires_spacing_and_preserves_integral_across_units() -> None:
    source = StructuredGridValue((2,), (np.array([0.5, 1.5]),), "m", "source")
    target = StructuredGridValue((1,), (np.array([1000.0]),), "mm", "target")
    field = FieldValue(source, "cell", "PowerDensity", "W.m-3", np.array([2.0, 4.0]))

    with pytest.raises(ValueError, match="explicit axis spacing"):
        project_structured_scalar_cell_averages(field, target)
    projected = project_structured_scalar_cell_averages(
        field, target, source_spacing=(1.0,), target_spacing=(2000.0,)
    )

    assert projected.domain is target
    np.testing.assert_allclose(projected.values, [3.0])
    assert float(projected.values.sum() * 2.0) == pytest.approx(float(field.values.sum()))


def test_named_orthotope_blocks_round_trip_preserves_cell_order_and_integral() -> None:
    grid = StructuredGridValue((4,), (np.array([0.25, 0.75, 1.25, 1.75]),), "m", "grid")
    mesh = UnstructuredMeshValue(
        np.array([[0.0], [1000.0], [2000.0]]),
        {"left": np.array([[0, 1]]), "right": np.array([[1, 2]])},
        "mm",
        "mesh",
    )
    field = FieldValue(grid, "cell", "PowerDensity", "W.m-3", np.array([2.0, 2.0, 4.0, 4.0]))

    projected = project_structured_scalar_cell_averages_to_orthotopes(
        field, mesh, source_spacing=(0.5,)
    )
    restored = project_orthotope_scalar_cell_averages_to_structured(
        projected, grid, target_spacing=(0.5,)
    )

    assert projected.domain is mesh
    np.testing.assert_allclose(projected.values, [2.0, 4.0])
    np.testing.assert_allclose(restored.values, field.values)
    assert float(projected.values.sum()) == pytest.approx(float(field.values.sum() * 0.5))
    np.testing.assert_array_equal(mesh.points[:, 0], [0.0, 1000.0, 2000.0])


def test_value_projection_keeps_existing_scalar_cell_and_support_restrictions() -> None:
    grid = StructuredGridValue((1,), (np.array([0.5]),), "m", "grid")
    mesh = UnstructuredMeshValue(np.array([[1.0], [2.0]]), np.array([[0, 1]]), "m")
    field = FieldValue(grid, "cell", "PowerDensity", "W.m-3", np.array([2.0]))

    with pytest.raises(ValueError, match="same region"):
        project_structured_scalar_cell_averages_to_orthotopes(field, mesh, source_spacing=(1.0,))
    with pytest.raises(ValueError, match="one scalar value per cell"):
        project_structured_scalar_cell_averages(replace(field, location="node"), grid)
    with pytest.raises(ValueError, match="one scalar value per cell"):
        project_structured_scalar_cell_averages(replace(field, values=np.ones((1, 3))), grid)


def test_value_projection_rejects_general_tetrahedral_cells() -> None:
    mesh = UnstructuredMeshValue(
        np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]),
        {"tetra4": np.array([[0, 1, 2, 3]])},
        "m",
    )
    grid = StructuredGridValue((1, 1, 1), (np.array([0.5]),) * 3, "m")
    field = FieldValue(mesh, "cell", "PowerDensity", "W.m-3", np.array([2.0]))

    with pytest.raises(ValueError, match="axis-aligned orthotopes"):
        project_orthotope_scalar_cell_averages_to_structured(
            field, grid, target_spacing=(1.0, 1.0, 1.0)
        )
