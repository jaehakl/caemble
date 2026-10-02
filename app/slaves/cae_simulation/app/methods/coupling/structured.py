from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np

from app.kernel.api.units import convert_ucum_value


def project_cell_field_conservative(
    values: np.ndarray[Any, Any],
    source_axes: list[Mapping[str, Any]],
    target_axes: list[Mapping[str, Any]],
    *,
    source_unit: str,
    target_unit: str,
) -> np.ndarray[Any, Any]:
    """Project scalar cell averages by exact axis overlaps."""
    values = np.asarray(values, dtype=np.float64)
    if source_unit != target_unit:
        source_axes = [_axis_in_unit(axis, source_unit, target_unit) for axis in source_axes]
    for axis, (source_axis, target_axis) in enumerate(zip(source_axes, target_axes, strict=True)):
        values = _project_axis(values, source_axis, target_axis, axis)
    return values


def _axis_in_unit(
    axis: Mapping[str, Any],
    source_unit: str,
    target_unit: str,
) -> dict[str, Any]:
    offset = convert_ucum_value(0, source_unit, target_unit)
    scale = convert_ucum_value(1, source_unit, target_unit) - offset
    return {
        "ticks": [float(tick) * scale + offset for tick in axis["ticks"]],
        "spacing": float(axis["spacing"]) * scale,
    }


def _project_axis(
    values: np.ndarray[Any, Any],
    source_axis: Mapping[str, Any],
    target_axis: Mapping[str, Any],
    axis: int,
) -> np.ndarray[Any, Any]:
    source_ticks = np.asarray(source_axis["ticks"], dtype=np.float64)
    target_ticks = np.asarray(target_axis["ticks"], dtype=np.float64)
    source_descending = source_ticks.size > 1 and source_ticks[-1] < source_ticks[0]
    target_descending = target_ticks.size > 1 and target_ticks[-1] < target_ticks[0]
    if source_descending:
        source_ticks = source_ticks[::-1]
        values = np.flip(values, axis=axis)
    if target_descending:
        target_ticks = target_ticks[::-1]
    source_edges = _cell_edges(source_ticks, float(source_axis["spacing"]))
    target_edges = _cell_edges(target_ticks, float(target_axis["spacing"]))
    overlap = np.maximum(
        0.0,
        np.minimum(target_edges[1:, None], source_edges[None, 1:])
        - np.maximum(target_edges[:-1, None], source_edges[None, :-1]),
    )
    source_widths = np.diff(source_edges)
    target_widths = np.diff(target_edges)
    scale = max(float(source_widths.sum()), float(target_widths.sum()), 1.0)
    tolerance = np.finfo(np.float64).eps * 512 * scale
    if not np.allclose(overlap.sum(axis=0), source_widths, rtol=1e-12, atol=tolerance) or not np.allclose(
        overlap.sum(axis=1), target_widths, rtol=1e-12, atol=tolerance
    ):
        raise ValueError("source and target structured grids must cover the same region")
    weights = overlap / target_widths[:, None]
    projected = np.tensordot(weights, np.moveaxis(values, axis, 0), axes=(1, 0))
    if target_descending:
        projected = projected[::-1]
    return np.moveaxis(projected, 0, axis)


def _cell_edges(ticks: np.ndarray[Any, Any], spacing: float) -> np.ndarray[Any, Any]:
    if ticks.size == 1:
        return np.asarray([ticks[0] - spacing / 2, ticks[0] + spacing / 2])
    midpoints = (ticks[:-1] + ticks[1:]) / 2
    return np.concatenate(
        (
            [ticks[0] - (midpoints[0] - ticks[0])],
            midpoints,
            [ticks[-1] + (ticks[-1] - midpoints[-1])],
        )
    )
