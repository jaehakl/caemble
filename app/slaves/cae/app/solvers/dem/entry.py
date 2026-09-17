"""ABI 3 spherical DEM, immutable continuation and passive particle observations."""

import numpy as np

from app.kernel.api import ParticleSetValue, QuantityArrayValue, SolverImplementation, SolverInvocation, SolverResult, StatePatch
from app.methods.particles.outputs import build_outputs, native_values
from app.methods.particles.time import read_settings, initial_window, advance_window, history_values

from .domain import model_request, build_model, wall_queries
from .formulation import DemStepper


def observe(state):
    return {name: state[name] for name in ("positions", "velocity", "angularVelocity")}


async def run(invocation: SolverInvocation) -> SolverResult:
    settings = read_settings(invocation.config, "dem")
    request = model_request(invocation)
    saved = invocation.state.get("dem", {}).get(invocation.task_name)
    if saved is None:
        model, initial = await build_model(invocation, request)
        saved = {**initial_window(initial, observe), "model": model, "clock": settings}
    else:
        model = saved["model"]
        if model["identity"] != request[-1] or any(
                saved["clock"][name] != settings[name] for name in ("dt", "duration", "windowSize")):
            raise ValueError("DEM checkpoint belongs to a different physical model or integration step")
        particles = saved["state"]
        saved = {**saved, "state": {
            "positions": particles.positions, "velocity": particles.attributes["velocity"].values,
            "angularVelocity": particles.attributes["angularVelocity"].values,
            "contactHistory": saved["contactHistory"], "frictionDissipation": saved["frictionDissipation"]}}
    saved = await advance_window(saved, settings, DemStepper(model, wall_queries(model)), observe,
                                 cancellation=invocation.cancellation, progress=invocation.progress)
    samples = history_values(saved)
    state = saved["state"]
    attributes = {
        "velocity": QuantityArrayValue("kinematics.Velocity", "m.s-1", state["velocity"], np.eye(3), ("x", "y", "z")),
        "angularVelocity": QuantityArrayValue("kinematics.AngularVelocity", "rad.s-1", state["angularVelocity"], np.eye(3), ("x", "y", "z")),
        "mass": QuantityArrayValue("Mass", "kg", model["mass"]),
        "radius": QuantityArrayValue("Length", "m", model["radius"]),
    }
    exports, visuals = native_values(invocation.config, invocation.descriptor, model, samples, attributes)
    patch = StatePatch()
    if "dem" not in invocation.state:
        patch = patch.put(("dem",), {})
    energy = .5 * np.sum(model["mass"][:, None] * state["velocity"]**2)
    energy += .5 * np.sum(model["inertia"][:, None] * state["angularVelocity"]**2)
    observations = {"time": saved["time"], "particleCount": len(model["mass"]),
                    "stepCount": saved["steps"], "kineticEnergy": float(energy)}
    saved = {**saved, "contactHistory": state["contactHistory"],
             "frictionDissipation": state["frictionDissipation"], "state": ParticleSetValue(
                 positions=state["positions"], unit="m", attributes=attributes,
                 particle_ids=model["particleIds"], material_indices=model["materialIndices"],
                 materials=model["materials"], coordinate_frame="world",
                 identity=f"{model['identity']}:{float(saved['time']).hex()}",
                 metadata={"time": saved["time"], "provenance": model["provenance"]})}
    return SolverResult(state_patch=patch.put(("dem", invocation.task_name), saved),
                        artifacts=build_outputs(invocation.config, invocation.descriptor, model, samples),
                        exports=exports, visualizations=visuals,
                        observations={name: value for name, value in observations.items()
                                      if name in invocation.descriptor.get("observations", {})})


implementation = SolverImplementation(abi_version=3, run=run)
