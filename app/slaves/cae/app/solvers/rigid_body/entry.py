"""ABI 3 composition for independent rigid solids and passive observations."""

import numpy as np

from app.kernel.api import SolverImplementation, SolverInvocation, SolverResult, StatePatch
from app.methods.rigid import angular_velocity

from .domain import build_model, model_request
from .evolution import advance_window, append_history, time_settings
from .outputs import build_native, build_outputs


async def run(invocation: SolverInvocation) -> SolverResult:
    settings = time_settings(invocation.config)
    request = model_request(invocation)
    saved = invocation.state.get("rigid_body", {}).get(invocation.task_name)
    if saved is None:
        model, initial = await build_model(invocation, request)
        saved = {**initial, "time": 0., "steps": 0, "nextDtTick": 1, "nextOutputTick": 1,
                 "completedWindows": 0, "history": append_history({}, [{"times": 0., **initial}])}
    else:
        model = saved["model"]
        if model["identity"] != request[-1]:
            raise ValueError("rigid checkpoint belongs to a different geometry, material or load model")
        if dict(saved["settings"]) != settings:
            raise ValueError("rigid continuation requires the checkpoint's time settings")
    saved = await advance_window(invocation, model, saved, settings)
    omega = angular_velocity(saved["orientation"], model["inverseInertias"], saved["angularMomentum"])
    with np.errstate(over="ignore", invalid="ignore"):
        kinetic = .5 * np.sum(model["masses"][:, None] * saved["velocity"]**2)
        kinetic += .5 * np.sum(omega * saved["angularMomentum"])
    if not np.isfinite(kinetic):
        raise ValueError(f"rigid kinetic energy is nonfinite at time {saved['time']:g} s for bodies {model['bodyIds']!r}")
    artifacts = await build_outputs(invocation, model, saved)
    exports, visualizations = build_native(invocation, model, saved)
    if invocation.cancellation is not None:
        invocation.cancellation.raise_if_cancelled()
    patch = StatePatch()
    if "rigid_body" not in invocation.state:
        patch = patch.put(("rigid_body",), {})
    patch = patch.put(("rigid_body", invocation.task_name), saved)
    return SolverResult(
        state_patch=patch, artifacts=artifacts, exports=exports, visualizations=visualizations,
        observations={"time": saved["time"], "bodyCount": len(model["masses"]),
                      "stepCount": saved["steps"], "kineticEnergy": float(kinetic), "contactCount": len(saved["contactHistory"]),
                      "maxPenetration": saved["maxPenetration"], "frictionDissipation": saved["frictionDissipation"]},
    )


implementation = SolverImplementation(abi_version=3, run=run)
