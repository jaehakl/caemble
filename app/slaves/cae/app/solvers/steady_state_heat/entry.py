"""Couple the heat source, solve the thermal domain, and publish temperatures."""

from __future__ import annotations

from app.kernel.api import SolverImplementation, SolverInvocation, SolverResult
from app.kernel.api.world import scalar_parameter

from .domain import build_heat_domain
from .formulation import solve_heat
from .outputs import build_heat_outputs


async def run(invocation: SolverInvocation) -> SolverResult:
    source = invocation.inputs.get("heatSource")
    heat_source = None if source is None else source.value
    setup = await build_heat_domain(invocation)
    result = await solve_heat(
        setup,
        heat_source,
        scalar_parameter(invocation.config["parameters"]["relativeTolerance"]),
        int(scalar_parameter(invocation.config["parameters"]["maxIterations"])),
        invocation.progress,
    )
    return SolverResult(
        artifacts=await build_heat_outputs(
            invocation.config,
            result,
            invocation.progress,
            invocation.descriptor,
        ),
        observations={
            "iterations": result.iterations,
            "relativeResidual": result.relative_residual,
        },
    )


implementation = SolverImplementation(abi_version=3, run=run)

__all__ = ["implementation"]
