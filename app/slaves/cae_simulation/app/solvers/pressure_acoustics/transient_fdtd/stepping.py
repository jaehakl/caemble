"""Leapfrog pressure/face velocity with passive half-cell resistive termination."""

import numpy as np


def initial_fields(grid):
    pressure = np.zeros(grid.shape, dtype=np.float64)
    velocities = []
    for axis in range(3):
        shape = list(grid.shape)
        shape[axis] += 1
        velocities.append(np.zeros(shape, dtype=np.float64))
    return pressure, velocities


def advance_step(grid, pressure, velocities, rules, dt, prescribed):
    """Advance caller-owned velocities in place; return pressure at the next tick.

    Checkpoint arrays are copied once when the invocation starts. In particular,
    these mutable working arrays are never shared with the accepted input state.
    """
    for axis, velocity in enumerate(velocities):
        interior = [slice(None)] * 3
        interior[axis] = slice(1, -1)
        velocity[tuple(interior)] -= dt * np.diff(pressure, axis=axis) / (grid.density * grid.spacing[axis])
    for rule in rules:
        boundary = [slice(None)] * 3
        boundary[rule.axis] = 0 if rule.side == 0 else -1
        boundary = tuple(boundary)
        velocity = velocities[rule.axis]
        sign = 2 * rule.side - 1
        if rule.method == "acoustics.impedance":
            inertia = grid.density * grid.spacing[rule.axis] / 2
            resistance = float(rule.parameters["resistance"])
            velocity[boundary] = ((inertia - dt * resistance / 2) * velocity[boundary]
                                  + sign * dt * pressure[boundary]) / (inertia + dt * resistance / 2)
        else:
            velocity[boundary] = sign * prescribed[(rule.axis, rule.side)]
    divergence = np.zeros(grid.shape)
    for axis, velocity in enumerate(velocities):
        divergence += np.diff(velocity, axis=axis) / grid.spacing[axis]
    return pressure - grid.density * grid.sound_speed**2 * dt * divergence


def discrete_energy(grid, previous_pressure, pressure, velocities, rules):
    """Energy at the velocity half tick, not an unstaggered physical square sum."""
    volume = float(np.prod(grid.spacing))
    kinetic = 0.
    for axis, velocity in enumerate(velocities):
        interior = [slice(None)] * 3
        interior[axis] = slice(1, -1)
        kinetic += grid.density * volume * np.sum(velocity[tuple(interior)]**2)
    for rule in rules:
        if rule.method == "acoustics.impedance":
            boundary = [slice(None)] * 3
            boundary[rule.axis] = 0 if rule.side == 0 else -1
            kinetic += grid.density * volume / 2 * np.sum(velocities[rule.axis][tuple(boundary)]**2)
    potential = volume / (grid.density * grid.sound_speed**2) * np.sum(previous_pressure * pressure)
    return float((kinetic + potential) / 2)
