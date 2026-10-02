"""WCSPH continuity, pressure and Newtonian viscosity on particle pairs.

Positions, velocities and accelerations use world Cartesian coordinates and SI
units. Fixed planes use reflected fluid support: pressure is extrapolated with
gravity and all velocity components change sign to impose a stationary no-slip
wall. Ghosts are workspace, never additional physical mass or exported particles.
"""

from itertools import product

import numpy as np
from scipy.spatial import cKDTree


def wendland(distance, smoothing_length):
    """Normalized three-dimensional C2 kernel and its radial derivative."""
    q = np.asarray(distance) / smoothing_length
    a = np.maximum(1.0 - q / 2.0, 0.0)
    coefficient = 21.0 / (16.0 * np.pi * smoothing_length**3)
    return coefficient * a**4 * (2.0 * q + 1.0), -5.0 * coefficient * q * a**3 / smoothing_length


def pressure(density, reference_density, sound_speed, exponent=7.0):
    """Tait pressure relative to the zero-pressure reference density."""
    if np.any(np.asarray(density) <= 0) or not np.all(np.isfinite(density)):
        raise ValueError("SPH density must remain finite and positive")
    return reference_density * sound_speed**2 / exponent * (
        (np.asarray(density) / reference_density)**exponent - 1.0
    )


def neighbors(positions, velocity, density, mass, settings):
    """Directed fluid-to-fluid/ghost pairs, including periodic images."""
    h, origin, size = settings["h"], settings["origin"], settings["size"]
    periodic = np.asarray(settings["periodic"], dtype=bool)
    points, speeds = np.asarray(positions), np.asarray(velocity)
    rho, masses = np.asarray(density), np.asarray(mass)
    pressures = pressure(rho, settings["density"], settings["soundSpeed"], settings["exponent"])
    for axis in np.flatnonzero(~periodic):
        before = len(points)
        for boundary, sign in ((origin[axis], 1.0), (origin[axis] + size[axis], -1.0)):
            distances = sign * (points[:before, axis] - boundary)
            chosen = np.flatnonzero((distances >= 0.0) & (distances < 2.0 * h))
            if not len(chosen):
                continue
            ghosts = points[chosen].copy()
            ghosts[:, axis] = 2.0 * boundary - ghosts[:, axis]
            ghost_pressure = pressures[chosen] + rho[chosen] * (
                (ghosts - points[chosen]) @ np.asarray(settings["gravity"])
            )
            bulk = settings["density"] * settings["soundSpeed"]**2 / settings["exponent"]
            if np.any(1.0 + ghost_pressure / bulk <= 0):
                raise ValueError("SPH wall extrapolation exceeds the Tait pressure range")
            ghost_density = settings["density"] * (1.0 + ghost_pressure / bulk)**(1.0 / settings["exponent"])
            points = np.concatenate((points, ghosts))
            speeds = np.concatenate((speeds, -speeds[chosen]))
            masses = np.concatenate((masses, masses[chosen]))
            rho = np.concatenate((rho, ghost_density))
            pressures = np.concatenate((pressures, ghost_pressure))
    offsets = np.asarray(list(product(*[(-1, 0, 1) if flag else (0,) for flag in periodic]))) * size
    source = np.tile(np.arange(len(points)), len(offsets))
    images = (points[None, :, :] + offsets[:, None, :]).reshape(-1, 3)
    pairs = cKDTree(positions).sparse_distance_matrix(cKDTree(images), 2.0 * h, output_type="coo_matrix")
    active = pairs.data > np.finfo(float).eps * h
    first, second, distance = pairs.row[active], pairs.col[active], pairs.data[active]
    mapped = source[second]
    return first, positions[first] - images[second], distance, speeds[mapped], rho[mapped], masses[mapped], pressures[mapped]


def evaluate(positions, velocity, density, mass, settings):
    """Return physical acceleration and continuity density rate without mutation."""
    first, displacement, distance, neighbor_velocity, neighbor_density, neighbor_mass, neighbor_pressure = neighbors(
        positions, velocity, density, mass, settings
    )
    _, radial = wendland(distance, settings["h"])
    gradient = displacement * (radial / distance)[:, None]
    relative = velocity[first] - neighbor_velocity
    local_pressure = pressure(density, settings["density"], settings["soundSpeed"], settings["exponent"])
    pressure_force = -neighbor_mass * (
        local_pressure[first] / density[first]**2 + neighbor_pressure / neighbor_density**2
    )
    viscosity = -2.0 * settings["viscosity"] * neighbor_mass * radial * distance / (
        density[first] * neighbor_density * (distance**2 + 0.01 * settings["h"]**2)
    )
    acceleration = np.broadcast_to(settings["gravity"], positions.shape).copy()
    np.add.at(acceleration, first, pressure_force[:, None] * gradient - viscosity[:, None] * relative)
    density_rate = np.zeros(len(positions))
    np.add.at(density_rate, first, neighbor_mass * np.einsum("ij,ij->i", relative, gradient))
    return acceleration, density_rate


def wrap_positions(positions, settings):
    result = np.asarray(positions).copy()
    for axis in np.flatnonzero(settings["periodic"]):
        result[:, axis] = settings["origin"][axis] + np.mod(
            result[:, axis] - settings["origin"][axis], settings["size"][axis]
        )
    return result


def stable_timestep(velocity, settings):
    speed = float(np.max(np.linalg.norm(velocity, axis=1), initial=0.0))
    acoustic = 0.2 * settings["h"] / (settings["soundSpeed"] + speed)
    viscosity = settings["viscosity"] / settings["density"]
    return min(acoustic, 0.1 * settings["h"]**2 / viscosity) if viscosity else acoustic


def step(positions, velocity, density, mass, settings, dt):
    """Explicit midpoint prediction/correction advances x, v and rho together."""
    acceleration, density_rate = evaluate(positions, velocity, density, mass, settings)
    midpoint_x = wrap_positions(positions + 0.5 * dt * velocity, settings)
    midpoint_v = velocity + 0.5 * dt * acceleration
    midpoint_rho = density + 0.5 * dt * density_rate
    acceleration, density_rate = evaluate(midpoint_x, midpoint_v, midpoint_rho, mass, settings)
    next_x = wrap_positions(positions + dt * midpoint_v, settings)
    next_v, next_rho = velocity + dt * acceleration, density + dt * density_rate
    if not all(np.all(np.isfinite(value)) for value in (next_x, next_v, next_rho)):
        raise ValueError("SPH integration produced a nonfinite particle state")
    if np.any(next_rho <= 0):
        raise ValueError("SPH integration produced nonpositive density")
    axes = np.flatnonzero(~np.asarray(settings["periodic"], dtype=bool))
    if np.any(next_x[:, axes] <= settings["origin"][axes]) or np.any(
        next_x[:, axes] >= (settings["origin"] + settings["size"])[axes]
    ):
        raise ValueError("SPH particle crossed a fixed wall; reduce the timestep or increase soundSpeed")
    return next_x, next_v, next_rho
