from __future__ import annotations

from typing import Any, Awaitable, Callable

import numpy as np

from app.methods.structured import dense_field
from app.kernel.api import FieldValue

from .formulation import HeatSolution


async def build_heat_outputs(
    config: dict[str, Any],
    result: HeatSolution,
    progress: Callable[[Any], Awaitable[None]],
    descriptor: dict[str, Any],
) -> dict[str, Any]:
    domain = result.setup.grid
    outputs = config["outputs"]
    artifacts: dict[str, Any] = {}
    temperature: FieldValue | None = None
    maximum: float | None = None
    for index, output in enumerate(outputs):
        method = output["methodId"]
        key = output["key"]
        if method == "heat.temperature":
            if temperature is None:
                values = dense_field(domain, result.system, result.active_values)
                data = next(
                    item["data"]
                    for item in descriptor["methods"]["outputs"]
                    if item["methodId"] == method
                )
                temperature = FieldValue(
                    domain=result.setup.field_domain,
                    location="cell",
                    values=values,
                    quantity_kind=data["quantityKind"],
                    unit=data["unit"],
                )
            artifacts[key] = temperature
        elif method == "heat.maximum-temperature":
            maximum = float(np.max(result.active_values)) if maximum is None else maximum
            artifacts[key] = {"value": maximum}
        await progress({"stage": "output", "completed": index + 1, "total": len(outputs)})
    return artifacts
