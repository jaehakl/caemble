"""One fixed-grid acoustic window, immutable restart and sampled recording chunks."""

import hashlib
import json
from numbers import Real

import numpy as np

from app.kernel.api import SolverResult, StatePatch
from app.methods.fields.box_grid import BoxGrid, RectilinearSampler, pack_box_grid

from ..parameters import parameter
from .domain import build_grid
from .sources import prepare_face_rules, prepare_surface_motion, prescribed_velocities
from .stepping import advance_step, discrete_energy, initial_fields


def time_settings(config, grid):
    rules = [r for r in config["initializations"] if r["methodId"] == "acoustics.time"]
    if len(rules) != 1:
        raise ValueError("transient acoustics requires one acoustics.time initialization")
    values = {k: parameter(v) for k, v in rules[0]["parameters"].items()}
    dt = float(values["dt"])
    total, window = values["totalSteps"], values.get("windowSteps", values["totalSteps"])
    if (not np.isfinite(dt) or dt <= 0 or any(isinstance(v, (bool, np.bool_)) or not np.isfinite(v)
            or int(v) != v or v < 1 for v in (total, window))):
        raise ValueError("acoustic dt must be positive and totalSteps/windowSteps must be positive integers")
    cfl_limit = .9 / (grid.sound_speed * np.sqrt(np.sum(grid.spacing**-2)))
    if dt > cfl_limit * (1 + 16 * np.finfo(float).eps):
        raise ValueError(f"acoustic dt {dt:g} exceeds the 0.9 CFL limit {cfl_limit:g} s")
    return dt, int(total), int(window)


def restart_identity(grid, dt, total_steps, rules, motion_identity):
    # Output stride and window length do not change the physical time grid.
    boundary = [[r.axis, r.side, r.method, r.parameters] for r in rules]
    value = ["pressure-velocity-half-cell-resistance@1", grid.identity, dt, total_steps,
             sorted(boundary, key=lambda r: (r[0], r[1])), motion_identity]
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


async def run_transient(invocation):
    if any(r["methodId"] == "acoustics.spectrum" for r in invocation.config["initializations"]):
        raise ValueError("acoustics.spectrum is supported only by harmonic analysis")
    if "surfaceMotion" in invocation.inputs:
        raise ValueError("harmonic surfaceMotion cannot be consumed by transient acoustics")
    grid = await build_grid(invocation)
    dt, total_steps, window_steps = time_settings(invocation.config, grid)
    rules = prepare_face_rules(grid, invocation.config["boundaryConditions"])
    saved = invocation.state.get("pressure_acoustics", {}).get(invocation.task_name)
    saved_step = 0 if saved is None else saved["restart"]["step"]
    if (isinstance(saved_step, (bool, np.bool_)) or not isinstance(saved_step, Real)
            or not np.isfinite(saved_step) or int(saved_step) != saved_step):
        raise ValueError("acoustic checkpoint step must be a finite integer")
    step = int(saved_step)
    if step < 0 or step >= total_steps:
        raise ValueError("acoustic task has already reached its configured totalSteps")
    end_step = min(step + window_steps, total_steps)
    start, end = step * dt, end_step * dt
    tolerance = min(1e-6 * dt, 64 * np.finfo(float).eps * total_steps * dt)
    motion_rule = next((r for r in rules if r.method == "acoustics.transient-surface-motion"), None)
    motion_input = invocation.inputs.get("transientSurfaceMotion")
    if (motion_rule is None) != (motion_input is None):
        raise ValueError("transientSurfaceMotion input and acoustics.transient-surface-motion boundary must be connected together")
    motion = None if motion_rule is None else prepare_surface_motion(motion_input.value, grid, motion_rule, start, end, tolerance)
    identity = restart_identity(grid, dt, total_steps, rules, None if motion is None else motion[2])
    pressure, velocities = initial_fields(grid)
    recording = {}
    if saved is not None:
        restart = saved["restart"]
        if restart.get("schema") != 1 or restart.get("identity") != identity or restart.get("timeOrigin") != 0. or restart.get("dt") != dt:
            raise ValueError("acoustic checkpoint belongs to a different grid/material/boundary/time/integration model")
        if (not np.array_equal(restart["gridOrigin"], grid.origin) or not np.array_equal(restart["gridSpacing"], grid.spacing)
                or not np.array_equal(restart["gridShape"], grid.shape)
                or restart["density"] != grid.density or restart["soundSpeed"] != grid.sound_speed):
            raise ValueError("acoustic checkpoint physical grid and material metadata do not match")
        if np.shape(restart["pressure"]) != grid.shape or any(np.shape(restart[name]) != velocity.shape
                for name, velocity in zip(("vx", "vy", "vz"), velocities, strict=True)):
            raise ValueError("acoustic checkpoint staggered field shapes do not match its grid")
        for name in ("pressure", "vx", "vy", "vz"):
            field = np.asarray(restart[name])
            if field.dtype.kind not in "fiu" or not np.all(np.isfinite(field)):
                raise ValueError(f"acoustic checkpoint {name} must contain finite real values")
        pressure = np.asarray(restart["pressure"], dtype=np.float64).copy()
        velocities = [np.asarray(restart[name], dtype=np.float64).copy() for name in ("vx", "vy", "vz")]
        recording = dict(saved["recording"])
        if set(recording) != {output["key"] for output in invocation.config["outputs"]}:
            raise ValueError("acoustic recording output keys changed; restart from the initial state")
    outputs = []
    definitions = {item["methodId"]: item["data"] for item in invocation.descriptor["methods"]["outputs"]}
    for output in invocation.config["outputs"]:
        if output["methodId"] != "acoustics.pressure-history":
            raise ValueError("transient acoustics outputs require acoustics.pressure-history")
        stride = parameter(output.get("parameters", {}).get("sampleEvery", 1))
        if isinstance(stride, (bool, np.bool_)) or not np.isfinite(stride) or int(stride) != stride or stride < 1:
            raise ValueError("acoustic sampleEvery must be a positive integer")
        box = BoxGrid(output["boxGrid"])
        definition = [output["methodId"], int(stride),
            [np.asarray(box.geometry[name]).tolist() for name in ("origin", "size", "rotation", "gridShape")],
            [box.geometry[name] for name in ("source", "rootId", "lengthUnit")]]
        signature = hashlib.sha256(json.dumps(definition, separators=(",", ":")).encode()).hexdigest()
        if saved is not None and recording[output["key"]].get("definition") != signature:
            raise ValueError("acoustic recording definition changed; restart from the initial state")
        if saved is None:
            recording[output["key"]] = {"definition": signature, "times": (), "values": ()}
        sampler = RectilinearSampler.prepare(grid.axes, box.points("m"), grid.bounds)
        times, samples = [], []
        if saved is None:
            times.append(0.)
            samples.append(sampler.sample(pressure))
        outputs.append((output, box, sampler, int(stride), times, samples))
    energy = 0.
    if invocation.progress is not None:
        await invocation.progress({"stage": "acoustic-time-plan", "completed": 0, "total": 1,
            "cellCount": int(np.prod(grid.shape)), "totalSteps": total_steps, "timeStep": dt,
            "outputValueCount": sum(int(np.prod(box.shape)) * (1 + total_steps // stride)
                                    for _, box, _, stride, _, _ in outputs)})
        await invocation.progress({"stage": "acoustic-time-response", "completed": step, "total": total_steps})
    for current in range(step, end_step):
        if invocation.cancellation is not None:
            invocation.cancellation.raise_if_cancelled()
        left, right = current * dt, (current + 1) * dt
        prescribed = prescribed_velocities(rules, motion, grid, left, right)
        old_pressure = pressure
        pressure = advance_step(grid, pressure, velocities, rules, dt, prescribed)
        for _, _, sampler, stride, times, samples in outputs:
            if (current + 1) % stride == 0:
                times.append(right)
                samples.append(sampler.sample(pressure))
        if current + 1 == end_step:
            energy = discrete_energy(grid, old_pressure, pressure, velocities, rules)
        if invocation.progress is not None and ((current + 1) % 128 == 0 or current + 1 == end_step):
            await invocation.progress({"stage": "acoustic-time-response", "completed": current + 1, "total": total_steps})
    artifacts = {}
    for output, box, _, _, times, samples in outputs:
        prior = recording[output["key"]]
        chunks = dict(prior)
        if times:
            time_chunk, value_chunk = np.asarray(times), np.stack(samples, axis=3)
            time_chunk.flags.writeable = value_chunk.flags.writeable = False
            chunks = {**prior, "times": (*prior["times"], time_chunk), "values": (*prior["values"], value_chunk)}
        recording[output["key"]] = chunks
        artifacts[output["key"]] = pack_box_grid(box, definitions[output["methodId"]],
            np.concatenate(chunks["values"], axis=3), times=np.concatenate(chunks["times"]))
    for array in (pressure, *velocities):
        array.flags.writeable = False
    restart = {"schema": 1, "identity": identity, "timeOrigin": 0., "dt": dt, "step": end_step,
               "gridIdentity": grid.identity, "gridOrigin": grid.origin, "gridSpacing": grid.spacing,
               "gridShape": np.asarray(grid.shape, dtype=np.int64), "density": grid.density, "soundSpeed": grid.sound_speed,
               "pressure": pressure,
               "vx": velocities[0], "vy": velocities[1], "vz": velocities[2]}
    for key in ("gridOrigin", "gridSpacing", "gridShape"):
        restart[key].flags.writeable = False
    patch = StatePatch()
    if "pressure_acoustics" not in invocation.state:
        patch = patch.put(("pressure_acoustics",), {})
    patch = patch.put(("pressure_acoustics", invocation.task_name), {"restart": restart, "recording": recording})
    return SolverResult(state_patch=patch, artifacts=artifacts, observations={
        "time": end, "stepCount": end_step, "totalSteps": total_steps,
        "cellCount": int(np.prod(grid.shape)), "timeStep": dt, "discreteEnergy": energy,
    })
