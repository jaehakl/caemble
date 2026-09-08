"""Build the conductor domain, solve its potential, and publish electrical outputs."""

from __future__ import annotations

from app.kernel.api import SolverImplementation, SolverInvocation, SolverResult
from app.kernel.api.world import scalar_parameter

from .domain import build_dc_domain
from .formulation import solve_dc
from .outputs import build_dc_outputs


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


implementation = SolverImplementation(abi_version=3, run=run)

__all__ = ["implementation"]
