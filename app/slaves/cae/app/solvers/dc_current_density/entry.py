"""ABI 3 multi-material DC finite-element solve."""

from app.kernel.api import SolverImplementation, SolverResult
from app.kernel.api.world import scalar_parameter

from .domain import build_dc_domain
from .formulation import solve_dc
from .outputs import build_dc_outputs


async def run(invocation):
    setup = await build_dc_domain(invocation)
    result = solve_dc(setup, scalar_parameter(invocation.config["parameters"]["relativeTolerance"]), invocation.cancellation)
    artifacts, exports = build_dc_outputs(invocation.config, invocation.descriptor, result)
    if invocation.progress is not None:
        await invocation.progress({"stage": "dc-fem", "completed": 1, "total": 1})
    return SolverResult(artifacts=artifacts, exports=exports, observations={
        "relativeResidual": result.relative_residual,
        "inputPower": result.input_power, "dissipatedPower": result.dissipated_power,
        "currentImbalance": float(sum(result.terminal_currents.values())),
        "powerImbalance": result.input_power - result.dissipated_power,
    })


implementation = SolverImplementation(abi_version=3, run=run)
