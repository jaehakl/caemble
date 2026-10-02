"""Evaluate a terminal drive on a Heat-owned physical time interval."""

import numpy as np

from app.kernel.api.world import scalar_parameter
from app.methods.coupling.clock import read_step_control


def pulse_voltage(artifact, domain, parameters):
    step = read_step_control(artifact, domain)
    on, off = (scalar_parameter(parameters[key]) for key in ("onTime", "offTime"))
    if min(on, off) <= 0:
        raise ValueError("pulse on/off times must be positive")
    period = on + off
    start, end = step["startTime"], step["endTime"]
    midpoint = .5 * (start + end)
    cycle = np.floor(midpoint / period)
    left, transition, right = cycle * period, cycle * period + on, (cycle + 1) * period
    tolerance = 64 * np.finfo(float).eps * max(period, abs(end))
    if start < left - tolerance or end > right + tolerance or start < transition - tolerance < end - 2 * tolerance:
        raise ValueError("thermal time interval crosses a pulse transition")
    return scalar_parameter(parameters["voltage"]) if midpoint < transition else 0.
