from __future__ import annotations

from collections.abc import Mapping
from itertools import product
from typing import Any

import numpy as np

from app.methods.mesh import UnstructuredMesh
from app.runtime_kernel.api.units import convert_ucum_value


def project_structured_to_unstructured_cell_field_conservative(
    field: Mapping[str, Any],
    target_mesh: UnstructuredMesh,
    *,
    target_length_unit: str,
) -> np.ndarray[Any, Any]:
    """Transfer a scalar cell-average field to an axis-aligned unstructured mesh.

    This exact-overlap implementation supports one- to three-dimensional
    segment, quadrilateral, and hexahedral cells whose vertices are the corners
    of axis-aligned boxes.  It deliberately rejects triangles, tetrahedra,
    rotated cells, and general polyhedra; those require element intersection or
    quadrature machinery that is outside this method's contract.

    Source and target cells must describe the same physical support.  Requiring
    mutual coverage prevents a partial-domain transfer from silently losing or
    creating the integral of the field.
    """
    source_ref = _structured_domain_ref(field)
    source_values = np.asarray(field["value"], dtype=np.float64)
    source_minimum, source_maximum = _structured_cell_bounds(source_ref)
    source_values = _scalar_cell_values(source_values, source_minimum.shape[0], "source")
    target_minimum, target_maximum = _orthotope_cell_bounds(target_mesh)
    target_minimum, target_maximum = _bounds_in_unit(
        target_minimum,
        target_maximum,
        target_length_unit,
        source_ref["referenceLengthUnit"],
    )
    return _project_matching_support(
        source_values,
        source_minimum,
        source_maximum,
        target_minimum,
        target_maximum,
    )


def project_unstructured_to_structured_cell_field_conservative(
    values: np.ndarray[Any, Any],
    source_mesh: UnstructuredMesh,
    target_domain_ref: Mapping[str, Any],
    *,
    source_length_unit: str,
) -> np.ndarray[Any, Any]:
    """Transfer scalar cell averages from axis-aligned cells to a structured grid.

    The unstructured cells are limited to axis-aligned segment/quad/hex
    orthotopes, and source and target supports must match.  The returned array
    has the structured grid's declared shape.
    """
    source_minimum, source_maximum = _orthotope_cell_bounds(source_mesh)
    target_minimum, target_maximum = _structured_cell_bounds(target_domain_ref)
    source_minimum, source_maximum = _bounds_in_unit(
        source_minimum,
        source_maximum,
        source_length_unit,
        target_domain_ref["referenceLengthUnit"],
    )
    projected = _project_matching_support(
        _scalar_cell_values(values, source_mesh.cell_count, "source"),
        source_minimum,
        source_maximum,
        target_minimum,
        target_maximum,
    )
    return projected.reshape(tuple(int(size) for size in target_domain_ref["shape"]))


def _structured_domain_ref(field: Mapping[str, Any]) -> Mapping[str, Any]:
    if field.get("location") != "cell" or not isinstance(field.get("domainRef"), Mapping):
        raise ValueError("structured coupling requires a cell field with a domainRef")
    return field["domainRef"]


def _structured_cell_bounds(
    domain_ref: Mapping[str, Any],
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]]:
    shape = tuple(int(size) for size in domain_ref["shape"])
    axes = tuple(domain_ref["axes"])
    if not 1 <= len(shape) <= 3 or len(axes) != len(shape):
        raise ValueError("structured coupling supports one- to three-dimensional grids")
    edges = tuple(
        _cell_edges(np.asarray(axis["ticks"], dtype=np.float64), float(axis["spacing"]))
        for axis in axes
    )
    if any(axis_edges.size != size + 1 for axis_edges, size in zip(edges, shape, strict=True)):
        raise ValueError("structured axis ticks must match the declared grid shape")
    intervals = tuple(
        np.column_stack((np.minimum(axis_edges[:-1], axis_edges[1:]), np.maximum(axis_edges[:-1], axis_edges[1:])))
        for axis_edges in edges
    )
    cell_indices = np.asarray(list(product(*(range(size) for size in shape))), dtype=np.int64)
    minimum = np.column_stack(
        tuple(intervals[axis][cell_indices[:, axis], 0] for axis in range(len(shape)))
    )
    maximum = np.column_stack(
        tuple(intervals[axis][cell_indices[:, axis], 1] for axis in range(len(shape)))
    )
    return minimum, maximum


def _orthotope_cell_bounds(
    mesh: UnstructuredMesh,
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]]:
    dimension = mesh.spatial_dimension
    if not 1 <= dimension <= 3:
        raise ValueError("unstructured conservative coupling supports one to three dimensions")
    coordinates = mesh.cell_coordinates()
    expected_vertex_count = 2**dimension
    if coordinates.shape[1] != expected_vertex_count:
        raise ValueError(
            "unstructured conservative coupling only supports axis-aligned "
            f"orthotopes with {expected_vertex_count} vertices per cell"
        )
    minimum = coordinates.min(axis=1)
    maximum = coordinates.max(axis=1)
    scale = np.maximum(1.0, np.max(np.abs(coordinates), axis=(1, 2)))
    tolerance = np.finfo(np.float64).eps * 64 * scale
    if np.any(maximum - minimum <= tolerance[:, None]):
        raise ValueError("unstructured conservative coupling rejects degenerate cells")
    for cell, cell_minimum, cell_maximum, cell_tolerance in zip(
        coordinates, minimum, maximum, tolerance, strict=True
    ):
        corners = np.asarray(list(product(*zip(cell_minimum, cell_maximum, strict=True))))
        if not all(
            np.any(np.all(np.isclose(cell, corner, rtol=0.0, atol=cell_tolerance), axis=1))
            for corner in corners
        ):
            raise ValueError(
                "unstructured conservative coupling requires axis-aligned orthotope cells"
            )
    return minimum, maximum


def _bounds_in_unit(
    minimum: np.ndarray[Any, Any],
    maximum: np.ndarray[Any, Any],
    source_unit: str,
    target_unit: str,
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any]]:
    if source_unit == target_unit:
        return minimum, maximum
    offset = convert_ucum_value(0, source_unit, target_unit, "cell coupling coordinates")
    scale = (
        convert_ucum_value(1, source_unit, target_unit, "cell coupling coordinates") - offset
    )
    converted_minimum = minimum * scale + offset
    converted_maximum = maximum * scale + offset
    return (
        np.minimum(converted_minimum, converted_maximum),
        np.maximum(converted_minimum, converted_maximum),
    )


def _project_matching_support(
    source_values: np.ndarray[Any, Any],
    source_minimum: np.ndarray[Any, Any],
    source_maximum: np.ndarray[Any, Any],
    target_minimum: np.ndarray[Any, Any],
    target_maximum: np.ndarray[Any, Any],
) -> np.ndarray[Any, Any]:
    if source_minimum.shape[1] != target_minimum.shape[1]:
        raise ValueError("source and target cell dimensions must match")
    overlap_extent = np.maximum(
        0.0,
        np.minimum(source_maximum[:, None, :], target_maximum[None, :, :])
        - np.maximum(source_minimum[:, None, :], target_minimum[None, :, :]),
    )
    overlap = np.prod(overlap_extent, axis=2)
    source_measure = np.prod(source_maximum - source_minimum, axis=1)
    target_measure = np.prod(target_maximum - target_minimum, axis=1)
    scale = max(float(source_measure.sum()), float(target_measure.sum()), 1.0)
    tolerance = np.finfo(np.float64).eps * 512 * scale
    if not np.allclose(overlap.sum(axis=1), source_measure, rtol=1e-12, atol=tolerance) or not np.allclose(
        overlap.sum(axis=0), target_measure, rtol=1e-12, atol=tolerance
    ):
        raise ValueError("source and target cell supports must cover the same region")
    return np.asarray((source_values @ overlap) / target_measure, dtype=np.float64)


def _scalar_cell_values(
    values: np.ndarray[Any, Any],
    cell_count: int,
    label: str,
) -> np.ndarray[Any, Any]:
    array = np.asarray(values, dtype=np.float64)
    if array.size != cell_count:
        raise ValueError(f"{label} scalar field must contain exactly one value per cell")
    return array.reshape(cell_count)


def _cell_edges(ticks: np.ndarray[Any, Any], spacing: float) -> np.ndarray[Any, Any]:
    if ticks.ndim != 1 or ticks.size == 0 or not np.isfinite(ticks).all():
        raise ValueError("structured axis ticks must be a non-empty finite vector")
    if not np.isfinite(spacing) or spacing <= 0:
        raise ValueError("structured axis spacing must be positive and finite")
    if ticks.size == 1:
        return np.asarray([ticks[0] - spacing / 2, ticks[0] + spacing / 2])
    differences = np.diff(ticks)
    if np.any(differences == 0) or not (np.all(differences > 0) or np.all(differences < 0)):
        raise ValueError("structured axis ticks must be strictly monotonic")
    midpoints = (ticks[:-1] + ticks[1:]) / 2
    return np.concatenate(
        ([ticks[0] - (midpoints[0] - ticks[0])], midpoints, [ticks[-1] + (ticks[-1] - midpoints[-1])])
    )
