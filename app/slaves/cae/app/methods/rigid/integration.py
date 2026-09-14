"""Explicit Lie midpoint integration and observation-only dense output.

The state is a mapping of batched position/velocity/angularMomentum [N,3] and
orientation [N,4] wxyz arrays. No per-body Python objects or mutable input state
are needed. Timing, gravity, body IDs and solver lifecycle remain with callers.
"""

import numpy as np

from .kinematics import accumulate_wrenches, angular_velocity
from .rotations import normalize_quaternion, quaternion_exp, quaternion_multiply, quaternion_to_matrix


def midpoint_step(state, mass, inverse_inertia_body, dt, *, force, torque,
                  attachment_body_indices=None, attachment_arms=None, attachment_forces=None):
    """Advance one positive step and return (new_state, dense_output_stages).

    force/torque are constant world resultants about the COM. Optional sparse
    attachment forces are constant in world axes, while their COM-relative arms
    rotate with their bodies. Their force and moment are added to the resultants.
    """
    if not np.isfinite(dt) or dt <= 0:
        raise ValueError("rigid time step must be finite and positive")
    position = np.asarray(state["position"], dtype=np.float64)
    velocity = np.asarray(state["velocity"], dtype=np.float64)
    orientation = np.asarray(state["orientation"], dtype=np.float64)
    momentum = np.asarray(state["angularMomentum"], dtype=np.float64)
    total_force, initial_torque = np.asarray(force, dtype=np.float64), np.asarray(torque, dtype=np.float64)
    if attachment_body_indices is not None:
        indices = np.asarray(attachment_body_indices, dtype=np.int64)
        rotation = quaternion_to_matrix(orientation[indices])
        arms = np.einsum("...ij,...j->...i", rotation, attachment_arms)
        added_force, added_torque = accumulate_wrenches(len(position), indices, attachment_forces, arms=arms)
        total_force, initial_torque = total_force + added_force, initial_torque + added_torque
    acceleration = total_force / np.asarray(mass, dtype=np.float64)[..., None]
    initial_omega = angular_velocity(orientation, inverse_inertia_body, momentum)
    midpoint_orientation = normalize_quaternion(quaternion_multiply(quaternion_exp(.5 * dt * initial_omega), orientation))
    midpoint_momentum = momentum + .5 * dt * initial_torque
    midpoint_velocity = velocity + .5 * dt * acceleration
    midpoint_omega = angular_velocity(midpoint_orientation, inverse_inertia_body, midpoint_momentum)
    midpoint_torque = np.asarray(torque, dtype=np.float64)
    if attachment_body_indices is not None:
        rotation = quaternion_to_matrix(midpoint_orientation[indices])
        arms = np.einsum("...ij,...j->...i", rotation, attachment_arms)
        _, added_torque = accumulate_wrenches(len(position), indices, attachment_forces, arms=arms)
        midpoint_torque = midpoint_torque + added_torque
    result = {
        "position": position + dt * midpoint_velocity,
        "velocity": velocity + dt * acceleration,
        "orientation": normalize_quaternion(quaternion_multiply(quaternion_exp(dt * midpoint_omega), orientation)),
        "angularMomentum": momentum + dt * midpoint_torque,
    }
    stages = {
        "initial": {"position": velocity, "velocity": acceleration, "orientation": initial_omega, "angularMomentum": initial_torque},
        "midpoint": {"position": midpoint_velocity, "velocity": acceleration, "orientation": midpoint_omega, "angularMomentum": midpoint_torque},
        "end": result,
    }
    return result, stages


def interpolate_step(state, stages, dt, fraction):
    """Sample a completed step without altering its accepted continuation state.

    The orientation stage stores world angular velocity, not quaternion rates.
    Its Lie polynomial preserves whole turns that endpoint SLERP would discard.
    Scalar fraction is in [0,1]; endpoint samples copy the exact accepted arrays.
    """
    if not np.isfinite(fraction) or fraction < 0 or fraction > 1:
        raise ValueError("rigid interpolation fraction must lie in [0, 1]")
    if fraction == 0 or fraction == 1:
        endpoint = state if fraction == 0 else stages["end"]
        return {name: np.asarray(endpoint[name]).copy() for name in ("position", "velocity", "orientation", "angularMomentum")}
    initial, midpoint = stages["initial"], stages["midpoint"]
    result = {}
    for name in ("position", "velocity", "angularMomentum"):
        increment = fraction * initial[name] + fraction**2 * (midpoint[name] - initial[name])
        result[name] = np.asarray(state[name]) + dt * increment
    rotation = dt * (fraction * initial["orientation"] + fraction**2 * (midpoint["orientation"] - initial["orientation"]))
    result["orientation"] = normalize_quaternion(quaternion_multiply(quaternion_exp(rotation), state["orientation"]))
    return result
