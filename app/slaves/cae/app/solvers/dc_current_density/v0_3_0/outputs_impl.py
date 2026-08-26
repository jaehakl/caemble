from __future__ import annotations

import hashlib
import json
from typing import Any, Awaitable, Callable

import numpy as np

from app.methods.structured import (
    STRUCTURED_GRID_KIND,
    axis_ticks,
    dense_voxel_field,
    structured_cell_field,
)
from app.runtime_kernel.api.world import scalar_parameter

from .formulation_impl import DcSolution, _cross_section, _gradient


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
    joule: dict[str, Any] | None = None
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
                        setup.legacy_terminals,
                    )
                    voxel_values[global_index] = setup.conductivity * float(np.dot(gradient, gradient))
                data = next(
                    item.get("data", {})
                    for item in descriptor["methods"]["outputs"]
                    if item["methodId"] == method
                )
                axes = [{"ticks": ticks[0]}, {"ticks": ticks[1]}, {"ticks": ticks[2]}]
                joule = structured_cell_field(
                    setup.domain_ref,
                    dense_voxel_field(domain, voxel_values),
                    axes,
                    quantity_kind=data.get("quantityKind"),
                    unit=data.get("unit"),
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
                    setup.legacy_terminals,
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
                field = structured_cell_field(
                    _cross_section_domain_ref(setup.domain_ref, axes, values.shape, position),
                    values[..., None] * domain.axis,
                    axes,
                    quantity_kind=data.get("quantityKind"),
                    unit=data.get("unit"),
                )
                if "basis" in data:
                    field["basis"] = data["basis"]
                artifacts[key] = field
        await progress({"stage": "output", "completed": index + 1, "total": len(outputs)})
    return artifacts


def _cross_section_domain_ref(
    parent: dict[str, Any],
    axes: list[dict[str, Any]],
    shape: tuple[int, ...],
    position: float,
) -> dict[str, Any]:
    signature = {
        "parentDomainId": parent["id"],
        "position": position,
        "referenceLengthUnit": parent["referenceLengthUnit"],
        "shape": list(shape),
        "axes": axes,
    }
    identity = hashlib.sha256(
        json.dumps(signature, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {"kind": STRUCTURED_GRID_KIND, "id": identity, **signature}
