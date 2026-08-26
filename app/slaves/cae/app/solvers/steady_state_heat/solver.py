from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Awaitable, Callable

import numpy as np

from app.methods.geometry import GeometryService
from app.methods.structured import is_structured_cell_field, structured_cell_field
from app.runtime_kernel.api.world import scalar_parameter
from app.solver_framework.models import SolverContext

from .domain import build_heat_domain
from .formulation import _volume_source, solve_heat
from .outputs import build_heat_outputs


async def run(context: SolverContext) -> dict[str, Any]:
    setup = await build_heat_domain(context)
    heat_source = _legacy_heat_source(context.inputs.get("heatSource"), setup.domain_ref)
    result = await solve_heat(
        setup,
        heat_source,
        scalar_parameter(context.config["parameters"]["relativeTolerance"]),
        int(scalar_parameter(context.config["parameters"]["maxIterations"])),
        context.progress,
    )
    return {
        "artifacts": await build_heat_outputs(context.config, result, context.progress),
        "observations": {
            "iterations": result.iterations,
            "relativeResidual": result.relative_residual,
        },
    }


def _legacy_heat_source(value: Any, domain_ref: Mapping[str, Any]) -> Any:
    """Confine ABI-v1's historical same-grid tensor assumption to its adapter."""
    if value is None or is_structured_cell_field(value):
        return value
    if not isinstance(value, Mapping) or "value" not in value:
        raise ValueError("legacy heatSource must contain a value")
    shape = tuple(int(size) for size in domain_ref["shape"])
    array = np.asarray(value["value"], dtype=np.float64)
    if array.size != int(np.prod(shape)):
        raise ValueError(f"legacy heatSource has {array.size} values; expected {int(np.prod(shape))}")
    return structured_cell_field(
        domain_ref,
        array.reshape(shape),
        domain_ref["axes"],
        quantity_kind="PowerDensity",
        unit="W.m-3",
    )


async def _run_heat(
    config: dict[str, Any],
    state: Any,
    inputs: dict[str, Any],
    world: dict[str, Any],
    geometry: GeometryService,
    progress: Callable[[Any], Awaitable[None]],
    descriptor: dict[str, Any],
) -> dict[str, Any]:
    return await run(SolverContext(config, state, inputs, world, geometry, progress, descriptor))


__all__ = ["run"]
