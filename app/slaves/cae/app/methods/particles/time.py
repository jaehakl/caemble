"""Accepted physical windows and passive samples, with solver-owned stepping."""

import asyncio
from collections.abc import Mapping
from time import monotonic

import numpy as np


def parameter(value):
    return value["value"] if isinstance(value, Mapping) else value


def read_settings(config, prefix):
    rules = [item for item in config["initializations"] if item["methodId"] == f"{prefix}.time"]
    if len(rules) != 1:
        raise ValueError(f"{prefix} requires exactly one {prefix}.time initialization")
    settings = {key: float(parameter(rules[0]["parameters"][key]))
                for key in ("dt", "duration", "windowSize", "outputInterval")}
    if any(not np.isfinite(value) or value <= 0 for value in settings.values()):
        raise ValueError("particle time settings must be finite and positive")
    return settings


def initial_window(state, observe):
    sample = {"times": 0.0, **observe(state)}
    return {"state": state, "time": 0.0, "steps": 0, "windows": 0,
            "history": {name: (np.asarray([value]),) for name, value in sample.items()}}


def history_values(saved, scope="cumulative"):
    if scope == "final":
        return {name: np.asarray([value]) for name, value in saved["endpoint"].items()}
    if scope != "cumulative":
        raise ValueError("particle output scope must be cumulative or final")
    result = {name: np.concatenate(chunks) for name, chunks in saved["history"].items()}
    tolerance = 8 * np.finfo(float).eps * max(abs(saved["time"]), np.finfo(float).tiny)
    if abs(result["times"][-1] - saved["time"]) <= tolerance:
        result["times"][-1] = saved["time"]
    else:
        result = {name: np.concatenate((value, np.asarray([saved["endpoint"][name]])))
                  for name, value in result.items()}
    return result


async def advance_window(saved, settings, step, observe, *, cancellation=None, progress=None, interpolate=None):
    current = float(saved["time"])
    if current >= settings["duration"]:
        raise ValueError("particle task has already reached its configured duration")
    end = min((saved["windows"] + 1) * settings["windowSize"], settings["duration"])
    if end <= current:
        raise ValueError("particle window cannot advance representable time")
    state, count = saved["state"], int(saved["steps"])
    samples, previous = [], observe(state)
    tick = int(np.floor(current / settings["outputInterval"] + 1e-10)) + 1
    last_progress = monotonic()
    while current < end:
        if cancellation is not None:
            cancellation.raise_if_cancelled()
        lattice = (np.floor(current / settings["dt"] + 1e-9) + 1) * settings["dt"]
        remaining = min(lattice, end) - current
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            candidate, used = step(state, remaining)
        if not np.isfinite(used) or used <= 0 or used > remaining * (1 + 1e-10):
            raise ValueError("particle step returned an invalid time increment")
        accepted = current + used
        if abs(accepted - end) < 8 * np.finfo(float).eps * max(abs(end), settings["dt"]):
            accepted = end
        following = observe(candidate)
        if any(not np.all(np.isfinite(value)) for value in following.values()):
            raise ValueError(f"particle state is nonfinite at time {accepted:g} s")
        tolerance = 8 * np.finfo(float).eps * max(abs(accepted), settings["outputInterval"])
        while tick * settings["outputInterval"] <= accepted + tolerance:
            sampled_time = tick * settings["outputInterval"]
            fraction = float(np.clip((sampled_time - current) / used, 0.0, 1.0))
            sampled = interpolate(previous, following, fraction) if interpolate is not None else {
                name: previous[name] + fraction * (value - previous[name])
                for name, value in following.items()}
            samples.append({"times": sampled_time, **sampled})
            tick += 1
        state, previous, current = candidate, following, accepted
        count += 1
        now = monotonic()
        if progress is not None and (now - last_progress >= .05 or current == end):
            await progress({"stage": "particle-motion", "completed": current, "total": settings["duration"]})
            last_progress = now
        await asyncio.sleep(0)
    history = dict(saved["history"])
    if samples:
        for name in samples[0]:
            chunk = np.asarray([sample[name] for sample in samples])
            chunk.setflags(write=False)
            history[name] = (*history[name], chunk)
    return {**saved, "state": state, "time": current, "steps": count,
            "windows": saved["windows"] + 1, "history": history,
            "endpoint": {"times": current, **previous}}
