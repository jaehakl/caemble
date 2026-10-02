"""Steady Stokes flow using the shared conservative pressure-correction solve."""

from dataclasses import replace

import numpy as np

from app.methods.finite_volume.tetrahedral import cell_operators
from .linear import LinearFlowSystem
from .periodic import split_gravity


async def solve_stokes(mesh, density, viscosity, gravity, boundary_velocity, boundary_pressure,
                       *, max_iterations=1000, tolerance=1e-8, cancellation=None,
                       progress=None, initial_pressure=None):
    if cancellation is not None:
        cancellation.raise_if_cancelled()
    boundary_velocity = np.asarray(boundary_velocity, dtype=float)
    boundary_pressure = np.asarray(boundary_pressure, dtype=float)
    velocity_fixed = np.all(np.isfinite(boundary_velocity), axis=1) & (mesh.neighbour < 0)
    pressure_fixed = np.isfinite(boundary_pressure) & (mesh.neighbour < 0)
    if len(mesh.periodic_vectors) and not np.any(velocity_fixed):
        raise ValueError("steady periodic flow requires a no-slip or prescribed velocity boundary to determine mean velocity")
    velocity_values = np.where(velocity_fixed[:, None], boundary_velocity, 0)
    center = np.average(mesh.cell_centers, axis=0, weights=mesh.cell_volumes)
    hydrostatic_gravity, driving_acceleration = split_gravity(mesh, gravity)
    hydrostatic = density * ((mesh.cell_centers - center) @ hydrostatic_gravity)
    face_hydrostatic = density * ((mesh.face_centers - center) @ hydrostatic_gravity)
    pressure_values = np.where(pressure_fixed, boundary_pressure - face_hydrostatic, 0)
    offset = float(np.mean(pressure_values[pressure_fixed])) if np.any(pressure_fixed) else 0.
    pressure_values = np.where(pressure_fixed, pressure_values - offset, 0)
    velocity_operators = cell_operators(mesh, velocity_fixed)
    pressure_operators = cell_operators(mesh, pressure_fixed)
    momentum_matrix = (-viscosity * mesh.divergence @ velocity_operators.normal_gradient).tocsr()
    momentum_rhs = viscosity * mesh.divergence @ (velocity_operators.normal_gradient_boundary @ velocity_values)
    momentum_rhs += density * mesh.cell_volumes[:, None] * driving_acceleration
    length = float(np.cbrt(mesh.cell_volumes.sum()))
    pressure_span = float(np.ptp(pressure_values[pressure_fixed])) if np.any(pressure_fixed) else 0.
    body_force_scale = density * float(np.linalg.norm(driving_acceleration))
    speed_scale = max(float(np.max(np.linalg.norm(velocity_values, axis=1))), pressure_span * length / viscosity,
                      body_force_scale * length**2 / viscosity)
    system = LinearFlowSystem(mesh, velocity_operators, pressure_operators, momentum_matrix, momentum_rhs,
                              velocity_fixed, pressure_fixed, velocity_values, pressure_values,
                              reference_speed=speed_scale, force_density_scale=viscosity * speed_scale / length**2 + body_force_scale)
    initial = None if initial_pressure is None else np.asarray(initial_pressure) - hydrostatic - offset
    result = await system.solve(initial, max_iterations=max_iterations, tolerance=tolerance,
                                cancellation=cancellation, progress=progress)
    return replace(result, pressure=result.pressure + offset + hydrostatic)
