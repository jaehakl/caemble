"""ABI 3 steady/transient heat and native electrothermal iteration artifacts."""

from app.kernel.api import SolverImplementation, SolverInvocation, SolverResult, StatePatch
from app.methods.fields.history import append_box_history

from .domain import build_heat_domain
from .evolution import evaluate_heat_invocation
from .outputs import build_heat_outputs


async def run(invocation: SolverInvocation) -> SolverResult:
    setup = await build_heat_domain(invocation)
    result, temperature, estimate, control, state, previous, accepted, status = evaluate_heat_invocation(invocation, setup)
    config = {**invocation.config, "exports": [], "outputs": [
        {**item, "methodId": item["methodId"].removesuffix("-history")} for item in invocation.config["outputs"]]}
    artifacts, _ = build_heat_outputs(config, invocation.descriptor, result)
    history_keys = {item["key"] for item in invocation.config["outputs"] if item["methodId"].endswith("-history")}
    if history_keys:
        history, values = append_box_history(None if previous is None else previous.get("history"),
            {key: artifacts[key] for key in history_keys}, status["time"], state["identity"])
        state["history"] = history
        artifacts.update(values)
    exports = {}
    available = {"heat.temperature": temperature, "heat.temperature-estimate": estimate, "heat.next-step": control}
    for output in invocation.config.get("exports", ()):
        value = available[output["methodId"]]
        if value is None:
            raise ValueError("heat.next-step requires transient analysis")
        exports[output["key"]] = value
    patch = StatePatch()
    if accepted and (control is not None or history_keys):
        if "heat_transfer" not in invocation.state:
            patch = patch.put(("heat_transfer",), {})
        patch = patch.put(("heat_transfer", invocation.task_name), state)
    if invocation.progress is not None:
        await invocation.progress({"stage": "heat-fem", "completed": 1, "total": 1,
            "time": status["time"], "couplingIteration": status["couplingIteration"],
            "couplingResidual": status["couplingResidual"]})
    observations = {
        "relativeResidual": result.relative_residual, "sourcePower": result.source_power,
        "outwardPower": result.outward_power, "fixedOutwardPower": result.fixed_outward_power,
        "fluxOutwardPower": result.flux_outward_power, "robinOutwardPower": result.robin_outward_power,
        "powerImbalance": result.source_power - result.outward_power - result.storage_power,
        "storedEnergy": result.stored_energy, "storagePower": result.storage_power, **status,
    }
    observations = {key: value for key, value in observations.items() if key in invocation.descriptor.get("observations", {})}
    return SolverResult(state_patch=patch, artifacts=artifacts, exports=exports, observations=observations)


implementation = SolverImplementation(abi_version=3, run=run)
