"""Array operations for rigid bodies and sparse body-attached points.

Positions and linear velocities refer to each center of mass. Quaternions map
body-local axes to world; inertia tensors are about the center of mass in body
axes. Angular velocities, forces and moments use world axes.
"""

import numpy as np

from .rotations import quaternion_to_matrix


def apply_world_inertia(orientation, inertia_body, vectors):
    """Apply R Ibody R.T without constructing the world inertia tensor."""
    rotation = quaternion_to_matrix(orientation)
    local = np.einsum("...ji,...j->...i", rotation, vectors)
    product = np.einsum("...ij,...j->...i", inertia_body, local)
    return np.einsum("...ij,...j->...i", rotation, product)


def angular_velocity(orientation, inverse_inertia_body, angular_momentum):
    """Compute world angular velocity from world angular momentum."""
    return apply_world_inertia(orientation, inverse_inertia_body, angular_momentum)


def local_to_world_points(position, orientation, points, body_indices=None):
    """Transform COM-relative local points; optional indices select their bodies."""
    position, orientation = np.asarray(position), np.asarray(orientation)
    if body_indices is not None:
        position, orientation = position[body_indices], orientation[body_indices]
    rotation = quaternion_to_matrix(orientation)
    return position + np.einsum("...ij,...j->...i", rotation, points)


def world_to_local_points(position, orientation, points, body_indices=None):
    """Transform world points into COM-relative local coordinates."""
    position, orientation = np.asarray(position), np.asarray(orientation)
    if body_indices is not None:
        position, orientation = position[body_indices], orientation[body_indices]
    rotation = quaternion_to_matrix(orientation)
    return np.einsum("...ji,...j->...i", rotation, np.asarray(points) - position)


def point_velocities(position, velocity, omega, points, body_indices=None):
    """Evaluate vCOM + omega cross (worldPoint - COM) for a point batch."""
    position, velocity, omega = np.asarray(position), np.asarray(velocity), np.asarray(omega)
    if body_indices is not None:
        position, velocity, omega = position[body_indices], velocity[body_indices], omega[body_indices]
    arms = np.asarray(points) - position
    return velocity + np.cross(omega, arms)


def accumulate_wrenches(body_count, body_indices, forces, *, moments=None, arms=None):
    """Reduce sparse world loads; arms are world vectors relative to each COM.

    Repeated body indices add independently, including pure moments and forces
    applied off-center. IDs are resolved to these numerical indices by callers.
    """
    indices = np.asarray(body_indices, dtype=np.int64)
    forces = np.asarray(forces, dtype=np.float64)
    total_force = np.zeros((body_count, 3), dtype=np.float64)
    total_moment = np.zeros_like(total_force)
    np.add.at(total_force, indices, forces)
    if moments is not None:
        np.add.at(total_moment, indices, moments)
    if arms is not None:
        np.add.at(total_moment, indices, np.cross(arms, forces))
    return total_force, total_moment
