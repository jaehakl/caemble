from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np

from app.methods.structured.fields import is_structured_cell_field
from app.runtime_kernel.api.units import convert_ucum_value


def values_on_structured_grid(
    artifact: Mapping[str, Any],
    target_domain_ref: Mapping[str, Any],
    *,
    quantity_kind: str | None = None,
    unit: str | None = None,
) -> np.ndarray[Any, Any]:
    if not is_structured_cell_field(artifact):
        raise ValueError(
            "structured-grid coupling requires a typed cell field with domainRef, "
            "location, quantityKind, and unit"
        )
    if not isinstance(artifact.get("quantityKind"), str) or not artifact["quantityKind"]:
        raise ValueError("structured-grid coupling requires a field quantityKind")
    if not isinstance(artifact.get("unit"), str) or not artifact["unit"]:
        raise ValueError("structured-grid coupling requires a field unit")
    if quantity_kind is not None and artifact["quantityKind"] != quantity_kind:
        raise ValueError(
            f"structured-grid coupling requires quantityKind {quantity_kind!r}, "
            f"got {artifact['quantityKind']!r}"
        )
    if unit is not None and artifact["unit"] != unit:
        raise ValueError(
            f"structured-grid coupling requires unit {unit!r}, got {artifact['unit']!r}"
        )
    target_shape = tuple(int(item) for item in target_domain_ref["shape"])
    values = np.asarray(artifact["value"], dtype=np.float64)
    if artifact["domainRef"]["id"] == target_domain_ref["id"]:
        if values.shape != target_shape:
            raise ValueError(
                f"same-domain field shape {values.shape!r} does not match {target_shape!r}"
            )
        return values
    return project_cell_field_conservative(artifact, target_domain_ref)


def project_cell_field_conservative(
    field: Mapping[str, Any],
    target_domain_ref: Mapping[str, Any],
) -> np.ndarray[Any, Any]:
    values = np.asarray(field["value"], dtype=np.float64)
    source_ref = field["domainRef"]
    source_axes = source_ref["axes"]
    target_axes = target_domain_ref["axes"]
    if source_ref["referenceLengthUnit"] != target_domain_ref["referenceLengthUnit"]:
        source_axes = [
            _axis_in_unit(
                axis,
                source_ref["referenceLengthUnit"],
                target_domain_ref["referenceLengthUnit"],
            )
            for axis in source_axes
        ]
    for axis, (source_axis, target_axis) in enumerate(zip(source_axes, target_axes, strict=True)):
        values = _project_axis(values, source_axis, target_axis, axis)
    return values


def _axis_in_unit(
    axis: Mapping[str, Any],
    source_unit: str,
    target_unit: str,
) -> dict[str, Any]:
    offset = convert_ucum_value(0, source_unit, target_unit, "structured field axis")
    scale = convert_ucum_value(1, source_unit, target_unit, "structured field axis") - offset
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
