"""ABI 3 steady multi-material heat transfer."""

from app.kernel.api import SolverImplementation, SolverResult
from app.kernel.api.world import scalar_parameter

from .domain import build_heat_domain
from .formulation import solve_heat
from .outputs import build_heat_outputs


async def run(invocation):
    setup = await build_heat_domain(invocation)
    source = invocation.inputs.get("heatSource")
    result = solve_heat(setup, None if source is None else source.value,
                        scalar_parameter(invocation.config["parameters"]["relativeTolerance"]), invocation.cancellation)
    artifacts, exports = build_heat_outputs(invocation.config, invocation.descriptor, result)
    if invocation.progress is not None:
        await invocation.progress({"stage": "heat-fem", "completed": 1, "total": 1})
    return SolverResult(artifacts=artifacts, exports=exports, observations={
        "relativeResidual": result.relative_residual, "sourcePower": result.source_power,
        "outwardPower": result.outward_power, "fixedOutwardPower": result.fixed_outward_power,
        "fluxOutwardPower": result.flux_outward_power, "robinOutwardPower": result.robin_outward_power,
        "powerImbalance": result.source_power - result.outward_power,
    })


implementation = SolverImplementation(abi_version=3, run=run)
