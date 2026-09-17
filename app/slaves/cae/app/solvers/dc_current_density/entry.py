"""ABI 3 multi-material DC finite-element solve."""

from dataclasses import replace

from app.kernel.api import ContentKey, SolverImplementation, SolverResult, StatePatch
from app.kernel.api.world import scalar_parameter
from app.methods.coupling.clock import read_step_control
from app.methods.fields.history import append_box_history

from .domain import build_dc_domain
from .formulation import solve_dc
from .outputs import build_dc_outputs


async def run(invocation):
    setup = await build_dc_domain(invocation)
    step = None
    if "stepControl" in invocation.inputs:
        step = read_step_control(invocation.inputs["stepControl"], setup.mesh.field_domain)
        if "temperature" in invocation.inputs:
            metadata = invocation.inputs["temperature"].value.metadata
            time = metadata.get("trialTime", metadata.get("time"))
            if (metadata.get("clockIdentity") != step["clockIdentity"]
                    or time not in (step["startTime"], step["endTime"])):
                raise ValueError("DC temperature and step-control must belong to the same physical interval")
    result = solve_dc(setup, scalar_parameter(invocation.config["parameters"]["relativeTolerance"]), invocation.cancellation,
                      backend=invocation.config["parameters"].get("linearSolver", "direct"))
    config = {**invocation.config, "outputs": [{**item, "methodId": item["methodId"].removesuffix("-history")}
                                              for item in invocation.config["outputs"]]}
    artifacts, exports = build_dc_outputs(config, invocation.descriptor, result)
    if step is not None:
        exports = {key: replace(value, metadata={**value.metadata,
            "clockIdentity": step["clockIdentity"], "time": step["endTime"]}) for key, value in exports.items()}
    patch = StatePatch()
    history_keys = {item["key"] for item in invocation.config["outputs"] if item["methodId"].endswith("-history")}
    if history_keys:
        if step is None:
            raise ValueError("DC history outputs require a Heat step-control")
        previous = invocation.state.get("dc_current_density", {}).get(invocation.task_name)
        identity = ContentKey.from_parts("dc-physical-history-v1", setup.mesh.field_domain.identity,
            invocation.config, invocation.world["materials"], step["clockIdentity"]).digest
        history, values = append_box_history(previous, {key: artifacts[key] for key in history_keys},
            step["endTime"], identity)
        artifacts.update(values)
        if "dc_current_density" not in invocation.state:
            patch = patch.put(("dc_current_density",), {})
        patch = patch.put(("dc_current_density", invocation.task_name), history)
    if invocation.progress is not None:
        await invocation.progress({"stage": "dc-fem", "completed": 1, "total": 1})
    return SolverResult(state_patch=patch, artifacts=artifacts, exports=exports, observations={
        "relativeResidual": result.relative_residual,
        "inputPower": result.input_power, "dissipatedPower": result.dissipated_power,
        "currentImbalance": float(sum(result.terminal_currents.values())),
        "powerImbalance": result.input_power - result.dissipated_power,
    })


implementation = SolverImplementation(abi_version=3, run=run)
