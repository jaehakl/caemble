"""Immutable cumulative Box Grid samples; orchestration selects accepted branches."""

import numpy as np


def append_history_chunk(previous, value, *, axis):
    """Coalesce small accepted samples without copying older full chunks."""
    chunks = []
    for chunk in (*previous, np.array(value, copy=True)):
        if chunks and chunks[-1].nbytes < 1024 * 1024 and chunk.nbytes < 1024 * 1024:
            chunks[-1] = np.concatenate((chunks[-1], chunk), axis=axis)
        else:
            chunks.append(chunk)
    return tuple(chunks)


def append_box_history(previous, artifacts, time, identity):
    previous = previous or {"identity": identity, "times": (), "samples": {}}
    if previous["identity"] != identity:
        raise ValueError("recording history belongs to a different physical domain")
    if previous["times"] and time <= previous["times"][-1]:
        raise ValueError("accepted recording times must be strictly increasing")
    times = (*previous["times"], float(time))
    samples, outputs = {}, {}
    if previous["samples"] and set(previous["samples"]) != set(artifacts):
        raise ValueError("history output selection cannot change while resuming a state")
    for key, artifact in artifacts.items():
        chunks = append_history_chunk(previous["samples"].get(key, ()), artifact["value"], axis=3)
        samples[key] = chunks
        axes = [dict(axis) for axis in artifact["axes"]]
        axes[3] = {"ticks": np.asarray(times), "unit": "s"}
        outputs[key] = {**artifact, "value": np.concatenate(chunks, axis=3), "axes": axes}
    return {"identity": identity, "times": times, "samples": samples}, outputs
