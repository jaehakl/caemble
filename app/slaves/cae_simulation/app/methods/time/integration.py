from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Generic, TypeVar

import numpy as np


Value = TypeVar("Value")


@dataclass(frozen=True, slots=True)
class TimeState(Generic[Value]):
    time: float
    value: Value


def explicit_euler(
    right_hand_side: Callable[[float, Value], Value],
    state: TimeState[Value],
    time_step: float,
) -> TimeState[Value]:
    return TimeState(state.time + time_step, state.value + time_step * right_hand_side(state.time, state.value))


def implicit_euler(
    solve_step: Callable[[float, Value, float], Value],
    state: TimeState[Value],
    time_step: float,
) -> TimeState[Value]:
    next_time = state.time + time_step
    return TimeState(next_time, solve_step(next_time, state.value, time_step))


def integrate(
    step: Callable[[TimeState[Value], float], TimeState[Value]],
    initial: TimeState[Value],
    time_step: float,
    steps: int,
    callback: Callable[[int, TimeState[Value]], None] | None = None,
) -> tuple[TimeState[Value], ...]:
    trajectory = [initial]
    state = initial
    for index in range(1, steps + 1):
        state = step(state, time_step)
        trajectory.append(state)
        if callback is not None:
            callback(index, state)
    return tuple(trajectory)


def integrate_piecewise_linear(times, values, start, end, sample_axis=0):
    """Integrate the represented linear waveform without extrapolation.

    The returned array has the input sample axis removed. Splitting an interval
    at arbitrary positions leaves its integrated value unchanged, including
    intervals that cross several source sample boundaries.
    """
    times = np.asarray(times, dtype=float)
    samples = np.moveaxis(np.asarray(values), sample_axis, 0)
    if (times.ndim != 1 or len(times) < 2 or not np.all(np.isfinite(times))
            or np.any(np.diff(times) <= 0) or len(samples) != len(times)):
        raise ValueError("waveform requires matching, strictly increasing finite time samples")
    if not np.isfinite(start) or not np.isfinite(end) or end < start:
        raise ValueError("waveform integration requires a finite ordered interval")
    if start < times[0] or end > times[-1]:
        raise ValueError("waveform integration interval is outside its sampled time range")
    integral = np.zeros(samples.shape[1:], dtype=np.result_type(samples, np.float64))
    if start == end:
        return integral
    first = min(np.searchsorted(times, start, side="right") - 1, len(times) - 2)
    last = min(np.searchsorted(times, end, side="left"), len(times) - 1)
    for index in range(first, last):
        left, right = max(start, times[index]), min(end, times[index + 1])
        step = times[index + 1] - times[index]
        # Integrate the affine function directly to avoid temporary time tensors.
        fraction = ((left + right) / 2 - times[index]) / step
        integral += (right - left) * (samples[index] + fraction * (samples[index + 1] - samples[index]))
    return integral
