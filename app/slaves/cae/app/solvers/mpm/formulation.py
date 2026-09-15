"""Quadratic APIC transfers and compressible Neo-Hookean stress in SI units."""

from itertools import product

import numpy as np

from app.methods.continuum.hyperelastic import InvalidDeformationError, neo_hookean


def stencil(positions, origin, spacing, shape):
    """27-node tensor-product quadratic weights and world gradients."""
    local = (positions - origin) / spacing
    base = np.floor(local - 0.5).astype(np.int64)
    fraction = local - base
    weights = np.stack((0.5 * (1.5 - fraction)**2, 0.75 - (fraction - 1.0)**2, 0.5 * (fraction - 0.5)**2), axis=1)
    derivatives = np.stack((fraction - 1.5, -2.0 * (fraction - 1.0), fraction - 0.5), axis=1) / spacing
    offset = np.asarray(list(product(range(3), repeat=3)))
    nodes = base[:, None, :] + offset[None, :, :]
    if np.any(nodes < 0) or np.any(nodes >= np.asarray(shape)):
        raise ValueError("MPM particle interpolation support left the fixed background grid")
    selected = weights[:, offset, np.arange(3)]
    weight = np.prod(selected, axis=2)
    gradient = np.empty_like(selected)
    for axis in range(3):
        other = [dimension for dimension in range(3) if dimension != axis]
        gradient[:, :, axis] = derivatives[:, offset[:, axis], axis] * np.prod(selected[:, :, other], axis=2)
    displacement = origin + nodes * spacing - positions[:, None, :]
    indices = np.ravel_multi_index(tuple(nodes[:, :, axis] for axis in range(3)), shape)
    return indices, weight, gradient, displacement


def particle_to_grid(positions, velocity, affine, mass, origin, spacing, shape):
    indices, weights, gradients, displacement = stencil(positions, origin, spacing, shape)
    grid_mass = np.zeros(int(np.prod(shape)))
    momentum = np.zeros((len(grid_mass), 3))
    weighted_mass = mass[:, None] * weights
    affine_velocity = velocity[:, None, :] + np.einsum("pij,pnj->pni", affine, displacement)
    np.add.at(grid_mass, indices, weighted_mass)
    np.add.at(momentum, indices, weighted_mass[:, :, None] * affine_velocity)
    return grid_mass, momentum, (indices, weights, gradients, displacement)


def grid_to_particle(grid_velocity, prepared, spacing):
    indices, weights, gradients, displacement = prepared
    values = grid_velocity[indices]
    velocity = np.einsum("pn,pni->pi", weights, values)
    affine = 4.0 / spacing**2 * np.einsum("pn,pni,pnj->pij", weights, values, displacement)
    gradient = np.einsum("pni,pnj->pij", values, gradients)
    return velocity, affine, gradient


def stable_timestep(velocity, deformation, settings):
    """Maximum current acoustic speed, evaluated without a fourth-order array.

    J Q(n) = mu (n.B.n) I + (lambda + mu - lambda log J) n n.T.
    Current density is rho0/J, so J cancels in the squared wave speed.
    """
    jacobian = np.linalg.det(deformation)
    if np.any(jacobian <= 0) or not np.all(np.isfinite(jacobian)):
        raise InvalidDeformationError("MPM accepted deformation requires finite positive J")
    stretches = np.linalg.svd(deformation, compute_uv=False)
    shear, lame = settings["shear"], settings["lame"]
    longitudinal = lame + shear - lame * np.log(jacobian)
    if np.any(shear * stretches[..., -1]**2 + np.minimum(longitudinal, 0) <= 0):
        raise InvalidDeformationError("MPM deformation is outside the strongly elliptic Neo-Hookean domain")
    speed_squared = (shear * stretches[..., 0]**2 + np.maximum(longitudinal, 0)) / settings["density"]
    wave_speed = float(np.sqrt(np.max(speed_squared)))
    speed = float(np.max(np.linalg.norm(velocity, axis=1), initial=0.0))
    if not np.isfinite(wave_speed + speed):
        raise InvalidDeformationError("MPM trial has a nonfinite wave or particle speed")
    return 0.2 * settings["spacing"] / (wave_speed + speed)


def step(positions, velocity, deformation, affine, mass, reference_volume, settings, dt):
    """P2G, grid forces/constraints, G2P and deformation-gradient update."""
    grid_mass, momentum, prepared = particle_to_grid(
        positions, velocity, affine, mass, settings["origin"], settings["spacing"], settings["shape"]
    )
    indices, weights, gradients, _ = prepared
    piola = neo_hookean(deformation, settings["shear"], settings["lame"]).piola
    kirchhoff = piola @ deformation.swapaxes(-1, -2)
    internal_force = -reference_volume[:, None, None] * np.einsum("pij,pnj->pni", kirchhoff, gradients)
    force = grid_mass[:, None] * np.asarray(settings["gravity"])
    np.add.at(force, indices, internal_force)
    active = grid_mass > 0
    grid_velocity = np.zeros_like(momentum)
    grid_velocity[active] = (momentum[active] + dt * force[active]) / grid_mass[active, None]
    grid_velocity[np.asarray(settings.get("fixedNodes", ()), dtype=np.int64)] = 0.0
    next_velocity, next_affine, velocity_gradient = grid_to_particle(grid_velocity, prepared, settings["spacing"])
    next_deformation = (np.eye(3) + dt * velocity_gradient) @ deformation
    next_positions = positions + dt * next_velocity
    if not all(np.all(np.isfinite(value)) for value in (next_positions, next_velocity, next_affine, next_deformation)):
        raise InvalidDeformationError("MPM integration produced a nonfinite particle trial")
    neo_hookean(next_deformation, settings["shear"], settings["lame"])
    stable_timestep(next_velocity, next_deformation, settings)
    # Fail in this trial, before accepting a particle without full support.
    stencil(next_positions, settings["origin"], settings["spacing"], settings["shape"])
    return next_positions, next_velocity, next_deformation, next_affine
