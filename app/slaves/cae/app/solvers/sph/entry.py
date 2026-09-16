"""ABI 3 orchestration for a frozen, three-dimensional WCSPH fluid."""

import numpy as np

from app.kernel.api import ParticleSetValue, QuantityArrayValue, SolverImplementation, SolverResult, StatePatch
from app.methods.particles.outputs import native_values
from app.methods.particles.time import advance_window, history_values, initial_window, read_settings

from .domain import build_model, model_request
from .formulation import pressure, stable_timestep, step
from .outputs import build_outputs


async def run(invocation):
    clock = read_settings(invocation.config, "sph")
    request = model_request(invocation)
    saved = invocation.state.get("sph", {}).get(invocation.task_name)
    if saved is None:
        model, state = await build_model(invocation, request)
    else:
        model = saved["model"]
        if model["identity"] != request[-1]:
            raise ValueError("SPH checkpoint belongs to different Geometry, Material or physical settings")
        if any(saved["clock"][name] != clock[name] for name in ("dt", "duration", "windowSize")):
            raise ValueError("SPH continuation requires the checkpoint's physical time settings")
        particles = saved["state"]
        state = {"positions": particles.positions,
                 "velocity": particles.attributes["velocity"].values,
                 "density": particles.attributes["density"].values}
    settings = model["settings"]

    def observe(values):
        return {**values, "pressure": pressure(values["density"], settings["density"], settings["soundSpeed"], settings["exponent"])}

    def advance(values, maximum):
        dt = min(maximum, stable_timestep(values["velocity"], settings))
        positions, velocity, density = step(values["positions"], values["velocity"], values["density"], model["mass"], settings, dt)
        return {"positions": positions, "velocity": velocity, "density": density}, dt

    def interpolate(first, second, fraction):
        result = {name: first[name] + fraction * (value - first[name]) for name, value in second.items()}
        for axis in np.flatnonzero(settings["periodic"]):
            width = settings["size"][axis]
            displacement = second["positions"][:, axis] - first["positions"][:, axis]
            displacement -= np.rint(displacement / width) * width
            result["positions"][:, axis] = settings["origin"][axis] + np.mod(
                first["positions"][:, axis] - settings["origin"][axis] + fraction * displacement, width)
        return result

    if saved is None:
        saved = initial_window(state, observe)
    else:
        saved = {**saved, "state": state}
    saved = await advance_window(saved, clock, advance, observe, cancellation=invocation.cancellation,
                                 progress=invocation.progress, interpolate=interpolate)
    state = saved["state"]
    attributes = {
        "velocity": QuantityArrayValue("kinematics.Velocity", "m.s-1", state["velocity"], basis=np.eye(3)),
        "mass": QuantityArrayValue("Mass", "kg", model["mass"]),
        "density": QuantityArrayValue("MassDensity", "kg.m-3", state["density"]),
        "pressure": QuantityArrayValue("Pressure", "Pa", saved["endpoint"]["pressure"]),
    }
    samples = history_values(saved)
    artifacts = build_outputs(invocation.config, invocation.descriptor, model, samples)
    exports, visualizations = native_values(invocation.config, invocation.descriptor, model, samples, attributes)
    saved = {**saved, "model": model, "clock": clock, "state": ParticleSetValue(
        positions=state["positions"], unit="m", attributes=attributes, particle_ids=model["particleIds"],
        material_indices=model["materialIndices"], materials=model["materials"], coordinate_frame="world",
        identity=f"{model['identity']}:{float(saved['time']).hex()}", metadata={"time": saved["time"], "provenance": model["provenance"]})}
    patch = StatePatch()
    if "sph" not in invocation.state:
        patch = patch.put(("sph",), {})
    patch = patch.put(("sph", invocation.task_name), saved)
    observations = {"time": saved["time"], "particleCount": len(model["mass"]), "stepCount": saved["steps"],
                    "kineticEnergy": float(0.5 * np.sum(model["mass"][:, None] * state["velocity"]**2)),
                    "maxDensityVariation": float(np.max(np.abs(state["density"] / settings["density"] - 1)))}
    return SolverResult(state_patch=patch, artifacts=artifacts, exports=exports, visualizations=visualizations,
                        observations={name: observations[name] for name in invocation.descriptor.get("observations", {})})


implementation = SolverImplementation(abi_version=3, run=run)
