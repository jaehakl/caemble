from __future__ import annotations

from app.runtime_kernel.api import InputArtifact, SolverInvocation, SolverResult
from app.runtime_kernel.api.world import scalar_parameter
from .domain_impl import build_heat_domain
from .formulation_impl import HeatSolution, solve_heat
from .outputs_impl import build_heat_outputs


async def run(invocation: SolverInvocation) -> SolverResult:
    heat_source = _heat_source(invocation.inputs.get("heatSource"))
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


def _heat_source(value: object) -> object:
    if value is None:
        return None
    if not isinstance(value, InputArtifact):
        raise TypeError("ABI-v2 heatSource must be a typed InputArtifact")
    if value.artifact_type != "caemble.dc/joule-heating@1":
        raise TypeError(
            "ABI-v2 heatSource requires artifact type caemble.dc/joule-heating@1"
        )
    return value.value


__all__ = ["HeatSolution", "run", "solve_heat"]
