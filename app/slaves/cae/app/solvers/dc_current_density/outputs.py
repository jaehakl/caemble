from __future__ import annotations

import hashlib
import json
from typing import Any, Awaitable, Callable

import numpy as np

from app.methods.structured import (
    axis_ticks,
    dense_voxel_field,
)
from app.kernel.api import FieldValue, StructuredGridValue
from app.kernel.api.world import scalar_parameter

from .formulation import DcSolution, _cross_section, _gradient


async def build_dc_outputs(
    config: dict[str, Any],
    descriptor: dict[str, Any],
    result: DcSolution,
    progress: Callable[[Any], Awaitable[None]],
) -> dict[str, Any]:
    setup = result.setup
    domain = setup.grid
    ticks = axis_ticks(domain)
    outputs = config["outputs"]
    artifacts: dict[str, Any] = {}
    cross_sections: dict[float, tuple[np.ndarray[Any, Any], float]] = {}
    density_positions = {
        scalar_parameter(output["parameters"]["crossSectionPosition"])
        for output in outputs
        if output["methodId"] == "dc.current-density"
    }
    joule: FieldValue | None = None
    for index, output in enumerate(outputs):
        method = output["methodId"]
        key = output["key"]
        if method == "dc.joule-heating":
            if joule is None:
                voxel_values = np.zeros(domain.occupancy.size, dtype=np.float64)
                for global_index in np.flatnonzero(domain.occupancy):
                    gradient = _gradient(
                        domain,
                        result.potential,
                        int(global_index),
                        setup.source_voltage,
                        setup.reference_voltage,
                        setup.surface_terminals,
                    )
                    voxel_values[global_index] = setup.conductivity * float(np.dot(gradient, gradient))
                data = next(
                    item.get("data", {})
                    for item in descriptor["methods"]["outputs"]
                    if item["methodId"] == method
                )
                joule = FieldValue(
                    domain=setup.field_domain,
                    location="cell",
                    values=dense_voxel_field(domain, voxel_values),
                    quantity_kind=data["quantityKind"],
                    unit=data["unit"],
                )
            artifacts[key] = joule
        elif method in {"dc.current-density", "dc.total-current"}:
            position = scalar_parameter(output["parameters"]["crossSectionPosition"])
            if position not in cross_sections:
                cross_sections[position] = _cross_section(
                    result.potential,
                    domain,
                    position,
                    setup.conductivity,
                    setup.source_voltage,
                    setup.reference_voltage,
                    position in density_positions,
                    setup.surface_terminals,
                )
            values, total = cross_sections[position]
            if method == "dc.total-current":
                artifacts[key] = {"value": total}
            else:
                data = next(
                    item.get("data", {})
                    for item in descriptor["methods"]["outputs"]
                    if item["methodId"] == method
                )
                axes = [
                    {"ticks": ticks[1], "spacing": domain.v_spacing},
                    {"ticks": ticks[2], "spacing": domain.u_spacing},
                ]
                field = FieldValue(
                    domain=_cross_section_field_domain(setup.field_domain, axes, values.shape, position),
                    location="cell",
                    values=values[..., None] * domain.axis,
                    quantity_kind=data["quantityKind"],
                    unit=data["unit"],
                    basis=data.get("basis"),
                    components=("x", "y", "z"),
                )
                artifacts[key] = field
        await progress({"stage": "output", "completed": index + 1, "total": len(outputs)})
    return artifacts


def _cross_section_field_domain(
    parent: StructuredGridValue,
    axes: list[dict[str, Any]],
    shape: tuple[int, ...],
    position: float,
) -> StructuredGridValue:
    signature = {
        "parentDomainId": parent.identity,
        "position": position,
        "referenceLengthUnit": parent.unit,
        "shape": list(shape),
        "axes": axes,
    }
    identity = hashlib.sha256(
        json.dumps(signature, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return StructuredGridValue(
        shape=shape,
        axes=tuple(np.asarray(axis["ticks"], dtype=np.float64) for axis in axes),
        unit=parent.unit,
        identity=identity,
        metadata={**signature, "spacings": [axis["spacing"] for axis in axes]},
    )
