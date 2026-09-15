"""Unilateral rigid impulses, Coulomb stick/slip and contact-aware substeps."""

import numpy as np

from app.methods.rigid import angular_velocity, quaternion_exp, quaternion_multiply, quaternion_to_matrix

from .collision import CollisionScene
from .domain import parameter


def contact_settings(config, model):
    rules = [rule for rule in config["initializations"] if rule["methodId"] == "rigid.contact"]
    if len(rules) > 1:
        raise ValueError("rigid.contact may be declared at most once")
    values = {key: parameter(value) for key, value in (rules[0]["parameters"] if rules else {}).items()}
    size = min(
        float(np.linalg.norm(np.ptp(model["vertices"][a:b], axis=0)))
        for a, b in zip(model["vertexOffsets"][:-1], model["vertexOffsets"][1:], strict=True)
    )
    settings = {
        "tolerance": float(values.get("tolerance", size * 1e-7)),
        "velocityTolerance": float(values.get("velocityTolerance", 1e-8)),
        "iterations": int(values.get("iterations", 200)),
        "maxSubsteps": int(values.get("maxSubsteps", 4096)),
    }
    if any(not np.isfinite(value) or value <= 0 for value in settings.values()):
        raise ValueError("rigid.contact settings must be finite and positive")
    return settings


def cross_matrix(vector):
    x, y, z = vector
    return np.array([[0.0, -z, y], [z, 0.0, -x], [-y, x, 0.0]])


def solve_contacts(state, free, model, contacts, settings, previous):
    rotation = quaternion_to_matrix(state["orientation"])
    inertia = rotation @ model["inverseInertias"] @ rotation.swapaxes(-1, -2)
    inertia[model["static"]] = 0
    inverse_mass = np.where(model["static"], 0.0, 1.0 / model["masses"])
    velocity = free["velocity"].copy()
    momentum = free["angularMomentum"].copy()
    velocity[model["static"]] = 0
    momentum[model["static"]] = 0
    omega = np.einsum("bij,bj->bi", inertia, momentum)
    free_omega = omega.copy()
    old_omega = angular_velocity(state["orientation"], model["inverseInertias"], state["angularMomentum"])
    constraints = []
    for contact in contacts:
        i, j, normal = contact["first"], contact["second"], contact["normal"]
        ra, rb = contact["point"] - state["position"][i], contact["point"] - state["position"][j]
        matrix = (
            (inverse_mass[i] + inverse_mass[j]) * np.eye(3)
            - cross_matrix(ra) @ inertia[i] @ cross_matrix(ra)
            - cross_matrix(rb) @ inertia[j] @ cross_matrix(rb)
        )
        axis = np.eye(3)[int(np.argmin(np.abs(normal)))]
        t1 = np.cross(normal, axis)
        t1 /= np.linalg.norm(t1)
        tangent = np.column_stack((t1, np.cross(normal, t1)))
        coefficients = model["contactCoefficients"][i, j]
        approach = normal @ (
            state["velocity"][j]
            + np.cross(old_omega[j], rb)
            - state["velocity"][i]
            - np.cross(old_omega[i], ra)
        )
        persistent = any(
            item["first"] == i
            and item["second"] == j
            and np.linalg.norm(np.asarray(item["point"]) - contact["point"]) < 10 * settings["tolerance"]
            for item in previous
        )
        rebound = -coefficients[2] * min(0.0, approach) if not persistent else 0.0
        constraints.append(
            {
                **contact,
                "ra": ra,
                "rb": rb,
                "matrix": matrix,
                "tangent": tangent,
                "coefficients": coefficients,
                "target": rebound,
                "lambda": 0.0,
                "friction": np.zeros(2),
            }
        )
    for _ in range(settings["iterations"]):
        change = 0.0
        for item in constraints:
            i, j = item["first"], item["second"]
            ra, rb, normal, tangent = item["ra"], item["rb"], item["normal"], item["tangent"]
            relative = velocity[j] + np.cross(omega[j], rb) - velocity[i] - np.cross(omega[i], ra)
            normal_mass = normal @ item["matrix"] @ normal
            new_lambda = max(0.0, item["lambda"] + (item["target"] - normal @ relative) / normal_mass)
            impulse = (new_lambda - item["lambda"]) * normal
            item["lambda"] = new_lambda
            relative += item["matrix"] @ impulse
            tangent_matrix = tangent.T @ item["matrix"] @ tangent
            driving = tangent.T @ relative - tangent_matrix @ item["friction"]
            trial = -np.linalg.solve(tangent_matrix, driving)
            static, dynamic, _ = item["coefficients"]
            if np.linalg.norm(trial) > static * new_lambda:
                radius = dynamic * new_lambda
                if radius == 0:
                    trial = np.zeros(2)
                else:
                    # Solve the disk-constrained quadratic in the contact metric.
                    # Its boundary impulse opposes the resulting slip velocity.
                    eigenvalues, basis = np.linalg.eigh(tangent_matrix)
                    driving_basis = basis.T @ driving
                    lower, upper = 0.0, np.linalg.norm(driving) / radius
                    for _ in range(40):
                        multiplier = (lower + upper) / 2
                        projected = -driving_basis / (eigenvalues + multiplier)
                        if np.linalg.norm(projected) > radius:
                            lower = multiplier
                        else:
                            upper = multiplier
                    trial = basis @ (-driving_basis / (eigenvalues + upper))
            friction_delta = tangent @ (trial - item["friction"])
            impulse += friction_delta
            item["friction"] = trial
            velocity[i] -= inverse_mass[i] * impulse
            velocity[j] += inverse_mass[j] * impulse
            momentum[i] -= np.cross(ra, impulse)
            momentum[j] += np.cross(rb, impulse)
            omega[i] = inertia[i] @ momentum[i]
            omega[j] = inertia[j] @ momentum[j]
            change = max(change, float(np.linalg.norm(item["matrix"] @ impulse)))
        if change <= settings["velocityTolerance"]:
            break
    else:
        raise ValueError("rigid contact impulse iteration did not converge")
    velocity[model["static"]] = 0
    momentum[model["static"]] = 0
    dissipated = 0.0
    for item in constraints:
        i, j, ra, rb = item["first"], item["second"], item["ra"], item["rb"]
        before = (
            free["velocity"][j]
            + np.cross(free_omega[j], rb)
            - free["velocity"][i]
            - np.cross(free_omega[i], ra)
        )
        after = velocity[j] + np.cross(omega[j], rb) - velocity[i] - np.cross(omega[i], ra)
        dissipated -= 0.5 * (item["tangent"] @ item["friction"]) @ (before + after)
    return velocity, momentum, constraints, max(0.0, dissipated)


class ContactStepper:
    def __init__(self, invocation, model, saved, free_step):
        self.model = model
        self.invocation = invocation
        self.settings = contact_settings(invocation.config, model)
        self.collision = CollisionScene(model, self.settings["tolerance"])
        self.free_step = free_step
        self.history = list(saved.get("contactHistory", []))
        self.dissipation = float(saved.get("frictionDissipation", 0.0))
        self.max_penetration = float(saved.get("maxPenetration", 0.0))
        self.steps = 0
        if saved["time"] == 0:
            self.collision.initial_overlap(saved)

    def unconstrained(self, state, dt):
        model = self.model
        free, stages = self.free_step(
            state,
            model["masses"],
            model["inverseInertias"],
            dt,
            force=model["force"],
            torque=model["torque"],
            attachment_body_indices=model["attachmentBodyIndices"],
            attachment_arms=model["attachmentArms"],
            attachment_forces=model["attachmentForces"],
        )
        for key in free:
            free[key][model["static"]] = state[key][model["static"]]
        return free, stages

    def advance(self, state, requested_dt):
        """Return an accepted substep and optional smooth dense-output stages.

        Minimum surface distance divided by a bound on vertex speed supplies a
        conservative advancement interval. Rotation is included through |omega| r.
        """
        model, settings = self.model, self.settings
        collision = self.collision
        if not collision.pairs:
            free, stages = self.unconstrained(state, requested_dt)
            return requested_dt, free, stages
        collision.place(state)
        contacts = collision.contacts()
        active = {(contact["first"], contact["second"]) for contact in contacts}
        omega = angular_velocity(state["orientation"], model["inverseInertias"], state["angularMomentum"])
        force_acceleration = np.linalg.norm(model["force"], axis=1) / model["masses"]
        attachment_acceleration = np.zeros(len(model["masses"]))
        for body, force in zip(model["attachmentBodyIndices"], model["attachmentForces"], strict=True):
            attachment_acceleration[body] += np.linalg.norm(force) / model["masses"][body]
        torque_bound = np.linalg.norm(model["torque"], axis=1)
        for body, arm, force in zip(
            model["attachmentBodyIndices"], model["attachmentArms"], model["attachmentForces"], strict=True
        ):
            torque_bound[body] += np.linalg.norm(arm) * np.linalg.norm(force)
        angular_bound = np.linalg.norm(model["inverseInertias"], axis=(1, 2)) * (
            np.linalg.norm(state["angularMomentum"], axis=1) + requested_dt * torque_bound
        )
        speed = (
            np.linalg.norm(state["velocity"], axis=1)
            + (force_acceleration + attachment_acceleration) * requested_dt
            + angular_bound * collision.radii
        )
        speed[model["static"]] = 0.0
        dt = requested_dt
        for i, j in collision.pairs:
            if (i, j) in active or speed[i] + speed[j] == 0:
                continue
            distance = collision.distance(i, j)
            if distance > settings["tolerance"] * 1.5:
                dt = min(dt, (distance - settings["tolerance"] * 1.5) / (speed[i] + speed[j]))
        spin = float(np.linalg.norm(omega, axis=1).max())
        if contacts and speed.max() > 0:
            # Limit changes of support while a pair is already touching.
            feature_size = min(
                float(np.linalg.norm(local[edges[:, 1]] - local[edges[:, 0]], axis=1).min())
                for local, edges in zip(collision.local, collision.edges, strict=True)
            )
            dt = min(dt, 0.25 * feature_size / float(speed.max()))
        if spin > 0 and contacts:
            dt = min(dt, 0.1 / spin)
        if dt < requested_dt * 1e-10:
            dt = min(requested_dt, settings["tolerance"] / max(float(speed.max()), 1e-30))
        if dt <= 0 or not np.isfinite(dt):
            raise ValueError("rigid collision advancement cannot advance time")
        while True:
            self.steps += 1
            if self.steps > settings["maxSubsteps"]:
                raise ValueError("rigid collision advancement exceeded maxSubsteps within one time step")
            cancellation = getattr(self.invocation, "cancellation", None)
            if cancellation is not None:
                cancellation.raise_if_cancelled()
            free, stages = self.unconstrained(state, dt)
            if not contacts:
                candidate = free
            else:
                velocity, momentum, solved, dissipation = solve_contacts(
                    state, free, model, contacts, settings, self.history
                )
                omega_end = angular_velocity(state["orientation"], model["inverseInertias"], momentum)
                orientation = quaternion_multiply(quaternion_exp(dt * omega_end), state["orientation"])
                candidate = {
                    "position": state["position"] + dt * velocity,
                    "velocity": velocity,
                    "orientation": orientation,
                    "angularMomentum": momentum,
                }
                for key in candidate:
                    candidate[key][model["static"]] = state[key][model["static"]]
            penetration = collision.penetration(candidate)
            if penetration <= settings["tolerance"]:
                break
            dt *= 0.5
            if dt <= np.finfo(float).eps * requested_dt:
                raise ValueError("rigid contact cannot resolve penetration within tolerance")
        self.max_penetration = max(self.max_penetration, penetration)
        if not contacts:
            self.history = []
            return dt, candidate, stages
        self.history = [
            {key: item[key] for key in ("first", "second", "point", "normal", "lambda", "friction")}
            for item in solved
        ]
        self.dissipation += dissipation
        self.max_penetration = max(self.max_penetration, max(-item["gap"] for item in contacts))
        if self.max_penetration > settings["tolerance"]:
            raise ValueError("rigid contact penetration exceeded tolerance; reduce dt")
        # Contact intervals have their own post-impulse trajectory; never interpolate across an impact.
        stages = {
            "initial": {
                "position": velocity,
                "velocity": np.zeros_like(velocity),
                "orientation": omega_end,
                "angularMomentum": np.zeros_like(momentum),
            },
            "midpoint": {
                "position": velocity,
                "velocity": np.zeros_like(velocity),
                "orientation": omega_end,
                "angularMomentum": np.zeros_like(momentum),
            },
            "end": candidate,
        }
        stages["start"] = {**state, "velocity": velocity, "angularMomentum": momentum}
        return dt, candidate, stages
