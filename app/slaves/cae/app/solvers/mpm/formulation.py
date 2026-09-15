"""Quadratic APIC transfers and compressible Neo-Hookean stress in SI units."""

from itertools import product

import numpy as np


def neo_hookean(deformation, shear, lame):
    """Return Cauchy stress, first Piola stress and reference energy density.

W = mu/2 (tr(F.T F)-3) - mu log(J) + lambda/2 log(J)^2.
No accepted deformation or constitutive state is mutated by this calculation.
"""
    deformation = np.asarray(deformation)
    jacobian = np.linalg.det(deformation)
    if np.any(jacobian <= 0) or not np.all(np.isfinite(jacobian)):
        raise ValueError("MPM Neo-Hookean deformation requires finite positive J")
    logarithm = np.log(jacobian)
    inverse_transpose = np.linalg.inv(deformation).swapaxes(-1, -2)
    piola = shear * (deformation - inverse_transpose) + lame * logarithm[..., None, None] * inverse_transpose
    cauchy = (piola @ deformation.swapaxes(-1, -2)) / jacobian[..., None, None]
    energy = 0.5 * shear * (np.sum(deformation**2, axis=(-1, -2)) - 3.0) - shear * logarithm + 0.5 * lame * logarithm**2
    return cauchy, piola, energy


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


def stable_timestep(velocity, settings):
    wave_speed = np.sqrt((settings["lame"] + 2.0 * settings["shear"]) / settings["density"])
    speed = float(np.max(np.linalg.norm(velocity, axis=1), initial=0.0))
    return 0.2 * settings["spacing"] / (wave_speed + speed)


def step(positions, velocity, deformation, affine, mass, reference_volume, settings, dt):
    """P2G, grid forces/constraints, G2P and deformation-gradient update."""
    grid_mass, momentum, prepared = particle_to_grid(
        positions, velocity, affine, mass, settings["origin"], settings["spacing"], settings["shape"]
    )
    indices, weights, gradients, _ = prepared
    _, piola, _ = neo_hookean(deformation, settings["shear"], settings["lame"])
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
        raise ValueError("MPM integration produced a nonfinite particle state")
    neo_hookean(next_deformation, settings["shear"], settings["lame"])
    # Fail in this trial, before accepting a particle without full support.
    stencil(next_positions, settings["origin"], settings["spacing"], settings["shape"])
    return next_positions, next_velocity, next_deformation, next_affine
