"""Accepted time windows and observation sampling, independent of spatial outputs."""

import asyncio
from time import monotonic

import numpy as np

from app.methods.rigid import midpoint_step, interpolate_step

from .domain import parameter


def time_settings(config):
    rules = [rule for rule in config["initializations"] if rule["methodId"] == "rigid.time"]
    if len(rules) != 1:
        raise ValueError("rigid_body requires exactly one rigid.time initialization")
    settings = {name: float(parameter(rules[0]["parameters"][name]))
                for name in ("dt", "duration", "windowSize", "outputInterval")}
    if any(not np.isfinite(value) or value <= 0 for value in settings.values()):
        raise ValueError("rigid time settings must be finite and positive")
    return settings


def append_history(history, samples):
    """Append a single immutable chunk per window without copying prior chunks."""
    if not samples:
        return dict(history)
    result = {}
    for key in samples[0]:
        chunk = np.asarray([sample[key] for sample in samples], dtype=np.float64)
        chunk.setflags(write=False)
        result[key] = (*history.get(key, ()), chunk)
    return result


def history_values(saved, scope="cumulative"):
    if scope not in {"cumulative", "final"}:
        raise ValueError("rigid output scope must be cumulative or final")
    return {name: chunks[-1][-1:] if scope == "final" else np.concatenate(chunks)
            for name, chunks in saved["history"].items()}


def validate_finite_state(state, model, time):
    """A numerical overflow must not become an accepted pose or native sample."""
    for name in ("position", "velocity", "orientation", "angularMomentum"):
        invalid = np.flatnonzero(~np.all(np.isfinite(state[name]), axis=-1))
        if len(invalid):
            bodies = [model["bodyIds"][index] for index in invalid]
            raise ValueError(f"rigid {name} is nonfinite at time {time:g} s for bodies {bodies!r}")


async def advance_window(invocation, model, saved, settings):
    state = {name: np.asarray(saved[name]).copy()
             for name in ("position", "velocity", "orientation", "angularMomentum")}
    current = float(saved["time"])
    if current >= settings["duration"]:
        raise ValueError("rigid task has already reached its configured duration")
    next_dt_tick, next_output_tick = int(saved["nextDtTick"]), int(saved["nextOutputTick"])
    window_count = int(saved["completedWindows"]) + 1
    window_end = min(window_count * settings["windowSize"], settings["duration"])
    if window_end <= current:
        raise ValueError("rigid time settings cannot advance representable time")
    samples = []
    last_output_time = float(saved["history"]["times"][-1][-1])
    last_progress = None
    steps = int(saved["steps"])
    while current < window_end:
        if invocation.cancellation is not None:
            invocation.cancellation.raise_if_cancelled()
        lattice = next_dt_tick * settings["dt"]
        # No output setting enters the physical boundary calculation.
        tolerance = min(32 * np.finfo(float).eps * max(abs(current), abs(lattice), abs(window_end)),
                        1e-6 * min(settings["dt"], settings["windowSize"]))
        if lattice <= current:
            raise ValueError("rigid time settings cannot advance representable time")
        # Decimal window multiplication can round to the other side of an
        # otherwise identical dt tick. Keep intermediate accepted steps on the
        # global lattice; only the explicit duration owns the final endpoint.
        if window_end != settings["duration"] and abs(lattice - window_end) <= tolerance:
            window_end = min(lattice, settings["duration"])
        end = min(lattice, window_end)
        if window_end == settings["duration"] and abs(end - window_end) <= tolerance:
            end = window_end
        if end <= current:
            raise ValueError("rigid time settings cannot advance representable time")
        step = end - current
        try:
            with np.errstate(over="raise", invalid="raise", divide="raise"):
                candidate, stages = midpoint_step(
                    state, model["masses"], model["inverseInertias"], step,
                    force=model["force"], torque=model["torque"],
                    attachment_body_indices=model["attachmentBodyIndices"],
                    attachment_arms=model["attachmentArms"], attachment_forces=model["attachmentForces"],
                )
        except (FloatingPointError, ValueError) as error:
            raise ValueError(f"rigid motion failed at time {end:g} s for bodies {model['bodyIds']!r}: {error}") from error
        validate_finite_state(candidate, model, end)
        while next_output_tick * settings["outputInterval"] <= end:
            if invocation.cancellation is not None:
                invocation.cancellation.raise_if_cancelled()
            output_time = next_output_tick * settings["outputInterval"]
            if output_time <= max(current, last_output_time):
                raise ValueError("rigid output settings cannot advance representable time")
            try:
                with np.errstate(over="raise", invalid="raise", divide="raise"):
                    sampled = candidate if output_time == end else interpolate_step(
                        state, stages, step, (output_time - current) / step)
            except (FloatingPointError, ValueError) as error:
                raise ValueError(f"rigid output failed at time {output_time:g} s for bodies {model['bodyIds']!r}: {error}") from error
            validate_finite_state(sampled, model, output_time)
            samples.append({"times": output_time, **sampled})
            last_output_time = output_time
            next_output_tick += 1
            await asyncio.sleep(0)
        if end == settings["duration"] and (not samples or samples[-1]["times"] != end):
            samples.append({"times": end, **candidate})
        state, current = candidate, end
        if lattice <= current + tolerance:
            next_dt_tick += 1
        steps += 1
        if invocation.progress is not None:
            now = monotonic()
            if last_progress is None or now - last_progress >= .05 or current == window_end:
                await invocation.progress({"stage": "rigid-motion", "completed": current,
                                           "total": settings["duration"]})
                last_progress = now
        await asyncio.sleep(0)
    return {**state, "time": current, "steps": steps, "nextDtTick": next_dt_tick,
            "nextOutputTick": next_output_tick, "completedWindows": window_count,
            "history": append_history(saved["history"], samples), "settings": dict(settings),
            "model": model}
