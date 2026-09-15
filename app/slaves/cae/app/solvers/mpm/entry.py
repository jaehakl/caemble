"""ABI 3 orchestration for explicit APIC and finite-strain elastic particles."""

import numpy as np

from app.kernel.api import ParticleSetValue, QuantityArrayValue, SolverImplementation, SolverResult, StatePatch
from app.methods.particles.outputs import build_outputs, native_values
from app.methods.particles.time import advance_window, history_values, initial_window, read_settings

from .domain import build_model, model_request
from .formulation import neo_hookean, stable_timestep, step


async def run(invocation):
    clock = read_settings(invocation.config, "mpm")
    request = model_request(invocation)
    saved = invocation.state.get("mpm", {}).get(invocation.task_name)
    if saved is None:
        model, state = await build_model(invocation, request)
    else:
        model = saved["model"]
        if model["identity"] != request[-1]:
            raise ValueError("MPM checkpoint belongs to different Geometry, Material or physical settings")
        if any(saved["clock"][name] != clock[name] for name in ("dt", "duration", "windowSize")):
            raise ValueError("MPM continuation requires the checkpoint's physical time settings")
        particles = saved["state"]
        state = {"positions": particles.positions,
                 "velocity": particles.attributes["velocity"].values,
                 "deformationGradient": particles.attributes["deformationGradient"].values,
                 "affineVelocityGradient": particles.attributes["affineVelocityGradient"].values}
    settings = model["settings"]

    def observe(values):
        stress, _, _ = neo_hookean(values["deformationGradient"], settings["shear"], settings["lame"])
        return {"positions": values["positions"], "velocity": values["velocity"],
                "deformationGradient": values["deformationGradient"], "stress": stress,
                "density": settings["density"] / np.linalg.det(values["deformationGradient"])}

    def advance(values, maximum):
        dt = min(maximum, stable_timestep(values["velocity"], settings))
        positions, velocity, deformation, affine = step(
            values["positions"], values["velocity"], values["deformationGradient"], values["affineVelocityGradient"],
            model["mass"], model["referenceVolume"], settings, dt)
        return {"positions": positions, "velocity": velocity, "deformationGradient": deformation,
                "affineVelocityGradient": affine}, dt

    if saved is None:
        saved = initial_window(state, observe)
    else:
        saved = {**saved, "state": state}
    saved = await advance_window(saved, clock, advance, observe, cancellation=invocation.cancellation, progress=invocation.progress)
    state, endpoint = saved["state"], saved["endpoint"]
    attributes = {
        "velocity": QuantityArrayValue("kinematics.Velocity", "m.s-1", state["velocity"], basis=np.eye(3)),
        "mass": QuantityArrayValue("Mass", "kg", model["mass"]),
        "density": QuantityArrayValue("MassDensity", "kg.m-3", endpoint["density"]),
        "stress": QuantityArrayValue("mechanics.StressTensor", "Pa", endpoint["stress"], basis=np.eye(3)),
        "deformationGradient": QuantityArrayValue("mechanics.DeformationGradient", "1", state["deformationGradient"], basis=np.eye(3)),
        "affineVelocityGradient": QuantityArrayValue("kinematics.VelocityGradient", "s-1", state["affineVelocityGradient"], basis=np.eye(3)),
        "referenceVolume": QuantityArrayValue("Volume", "m3", model["referenceVolume"]),
    }
    samples = history_values(saved)
    artifacts = build_outputs(invocation.config, invocation.descriptor, model, samples)
    exports, visualizations = native_values(invocation.config, invocation.descriptor, model, samples, attributes)
    saved = {**saved, "model": model, "clock": clock, "state": ParticleSetValue(
        positions=state["positions"], unit="m", attributes=attributes, particle_ids=model["particleIds"],
        material_indices=model["materialIndices"], materials=model["materials"], coordinate_frame="world",
        identity=f"{model['identity']}:{float(saved['time']).hex()}", metadata={"time": saved["time"], "provenance": model["provenance"]})}
    patch = StatePatch()
    if "mpm" not in invocation.state:
        patch = patch.put(("mpm",), {})
    patch = patch.put(("mpm", invocation.task_name), saved)
    _, _, energy = neo_hookean(state["deformationGradient"], settings["shear"], settings["lame"])
    observations = {"time": saved["time"], "particleCount": len(model["mass"]), "stepCount": saved["steps"],
                    "kineticEnergy": float(0.5 * np.sum(model["mass"][:, None] * state["velocity"]**2)),
                    "strainEnergy": float(np.sum(model["referenceVolume"] * energy))}
    return SolverResult(state_patch=patch, artifacts=artifacts, exports=exports, visualizations=visualizations,
                        observations={name: observations[name] for name in invocation.descriptor.get("observations", {})})


implementation = SolverImplementation(abi_version=3, run=run)
