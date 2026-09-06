from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import replace
from typing import Any

import numpy as np

from app.methods.coupling.cell import (
    project_structured_to_unstructured_cell_field_conservative,
    project_unstructured_to_structured_cell_field_conservative,
)
from app.methods.coupling.structured import project_cell_field_conservative
from app.methods.mesh import UnstructuredMesh
from app.runtime_kernel.api import FieldLocation, FieldValue, StructuredGridValue, UnstructuredMeshValue


def project_structured_scalar_cell_averages(
    field: FieldValue,
    target: StructuredGridValue,
    *,
    source_spacing: Sequence[float] | None = None,
    target_spacing: Sequence[float] | None = None,
) -> FieldValue:
    """Project scalar cell averages using the existing structured overlap method.

    A matching domain identity shares the original values, including their dtype.
    Otherwise callers supply each grid's axis spacing in its own length unit;
    coordinate vectors alone do not describe the width of a one-cell axis.
    """
    if not isinstance(field.domain, StructuredGridValue):
        raise TypeError("structured projection requires a structured source grid")
    if field.location != FieldLocation.CELL or np.shape(field.values) != field.domain.shape:
        raise ValueError("structured projection requires one scalar value per cell")
    if field.domain is target or (
        field.domain.identity is not None and field.domain.identity == target.identity
    ):
        if np.shape(field.values) != target.shape:
            raise ValueError("same-domain scalar field shape must match the target grid")
        return replace(field, domain=target)
    values = project_cell_field_conservative(
        {"value": field.values, "domainRef": _grid_ref(field.domain, source_spacing)},
        _grid_ref(target, target_spacing),
    )
    return replace(field, domain=target, values=values)


def project_structured_scalar_cell_averages_to_orthotopes(
    field: FieldValue,
    target: UnstructuredMeshValue,
    *,
    source_spacing: Sequence[float],
) -> FieldValue:
    """Project onto axis-aligned segment/quad/hex cells with matching support.

    Named cell blocks are traversed in their mapping order. General tetrahedra,
    rotated cells and partial-domain transfers retain the core method's errors.
    """
    if not isinstance(field.domain, StructuredGridValue):
        raise TypeError("structured projection requires a structured source grid")
    if field.location != FieldLocation.CELL or np.shape(field.values) != field.domain.shape:
        raise ValueError("structured projection requires one scalar value per cell")
    cells = target.cells
    if isinstance(cells, Mapping):
        cells = np.concatenate(tuple(cells.values()), axis=0)
    values = project_structured_to_unstructured_cell_field_conservative(
        {
            "location": "cell",
            "value": field.values,
            "domainRef": _grid_ref(field.domain, source_spacing),
        },
        UnstructuredMesh(target.points, cells),
        target_length_unit=target.unit,
    )
    return replace(field, domain=target, values=values)


def project_orthotope_scalar_cell_averages_to_structured(
    field: FieldValue,
    target: StructuredGridValue,
    *,
    target_spacing: Sequence[float],
) -> FieldValue:
    """Project axis-aligned segment/quad/hex cell averages to a matching grid.

    Field values follow the source mesh's named cell-block order, when present.
    This adapter does not add general unstructured interpolation.
    """
    if not isinstance(field.domain, UnstructuredMeshValue):
        raise TypeError("orthotope projection requires an unstructured source mesh")
    if field.location != FieldLocation.CELL:
        raise ValueError("orthotope projection requires one scalar value per cell")
    cells = field.domain.cells
    if isinstance(cells, Mapping):
        cells = np.concatenate(tuple(cells.values()), axis=0)
    values = project_unstructured_to_structured_cell_field_conservative(
        field.values,
        UnstructuredMesh(field.domain.points, cells),
        _grid_ref(target, target_spacing),
        source_length_unit=field.domain.unit,
    )
    return replace(field, domain=target, values=values)


def _grid_ref(
    domain: StructuredGridValue,
    spacing: Sequence[float] | None,
) -> dict[str, Any]:
    if spacing is None:
        raise ValueError("structured cell-average projection requires explicit axis spacing")
    return {
        "shape": domain.shape,
        "referenceLengthUnit": domain.unit,
        "axes": [
            {"ticks": ticks, "spacing": width}
            for ticks, width in zip(domain.axes, spacing, strict=True)
        ],
    }
