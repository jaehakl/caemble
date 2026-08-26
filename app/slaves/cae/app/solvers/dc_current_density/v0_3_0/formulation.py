from __future__ import annotations

from app.runtime_kernel.api import SolverInvocation, SolverResult
from app.runtime_kernel.api.world import scalar_parameter

from .domain_impl import build_dc_domain
from .formulation_impl import DcSolution, solve_dc
from .outputs_impl import build_dc_outputs


async def run(invocation: SolverInvocation) -> SolverResult:
    setup = await build_dc_domain(invocation)
    result = await solve_dc(
        setup,
        scalar_parameter(invocation.config["parameters"]["relativeTolerance"]),
        int(scalar_parameter(invocation.config["parameters"]["maxIterations"])),
        invocation.progress,
    )
    return SolverResult(
        artifacts=await build_dc_outputs(
            invocation.config,
            invocation.descriptor,
            result,
            invocation.progress,
        ),
        observations={
            "iterations": result.iterations,
            "relativeResidual": result.relative_residual,
        },
    )


__all__ = ["DcSolution", "run", "solve_dc"]
