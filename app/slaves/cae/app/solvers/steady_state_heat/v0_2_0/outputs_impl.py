from __future__ import annotations

from typing import Any, Awaitable, Callable

import numpy as np

from app.methods.structured import axis_ticks, dense_field, structured_cell_field

from .formulation_impl import HeatSolution


async def build_heat_outputs(
    config: dict[str, Any],
    result: HeatSolution,
    progress: Callable[[Any], Awaitable[None]],
    descriptor: dict[str, Any] | None = None,
) -> dict[str, Any]:
    domain = result.setup.grid
    ticks = axis_ticks(domain)
    outputs = config["outputs"]
    artifacts: dict[str, Any] = {}
    temperature: dict[str, Any] | None = None
    maximum: float | None = None
    for index, output in enumerate(outputs):
        method = output["methodId"]
        key = output["key"]
        if method == "heat.temperature":
            if temperature is None:
                values = dense_field(domain, result.system, result.active_values)
                axes = [
                    {"ticks": ticks[0], "spacing": domain.axial_spacing},
                    {"ticks": ticks[1], "spacing": domain.v_spacing},
                    {"ticks": ticks[2], "spacing": domain.u_spacing},
                ]
                if descriptor is None:
                    temperature = {"value": values, "axes": axes}
                else:
                    data = next(
                        item.get("data", {})
                        for item in descriptor["methods"]["outputs"]
                        if item["methodId"] == method
                    )
                    temperature = structured_cell_field(
                        result.setup.domain_ref,
                        values,
                        axes,
                        quantity_kind=data.get("quantityKind"),
                        unit=data.get("unit"),
                    )
            artifacts[key] = temperature
        elif method == "heat.maximum-temperature":
            maximum = float(np.max(result.active_values)) if maximum is None else maximum
            artifacts[key] = {"value": maximum}
        await progress({"stage": "output", "completed": index + 1, "total": len(outputs)})
    return artifacts
