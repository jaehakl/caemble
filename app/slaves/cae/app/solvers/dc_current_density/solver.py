from __future__ import annotations

from typing import Any, Awaitable, Callable

from app.methods.geometry import GeometryService
from app.runtime_kernel.api.world import scalar_parameter
from app.solver_framework.models import SolverContext

from .domain import build_dc_domain
from .formulation import _cross_section, _gradient, solve_dc
from .outputs import build_dc_outputs


async def run(context: SolverContext) -> dict[str, Any]:
    setup = await build_dc_domain(context)
    result = await solve_dc(
        setup,
        scalar_parameter(context.config["parameters"]["relativeTolerance"]),
        int(scalar_parameter(context.config["parameters"]["maxIterations"])),
        context.progress,
    )
    return {
        "artifacts": await build_dc_outputs(context.config, context.descriptor, result, context.progress),
        "observations": {
            "iterations": result.iterations,
            "relativeResidual": result.relative_residual,
        },
    }


async def _run_dc(
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
