from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Generic, TypeVar


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
