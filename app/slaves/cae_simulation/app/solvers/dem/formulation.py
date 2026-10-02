"""Nonadhesive spring-damper contacts with rotational Coulomb history."""

import numpy as np
from scipy.spatial import cKDTree


class DemStepper:
    def __init__(self, model, walls):
        self.model = model
        self.walls = walls

    def stable_step(self, state, maximum):
        model = self.model
        masses, radii = model["mass"], model["radius"]
        # Bounds use material pairs and the smallest represented mass, never an N*N array.
        effective = .5 * masses.min()
        tangent = (2 / 7) * effective
        bound = float(maximum)
        for coefficients in model["coefficients"].values():
            kn, kt, cn, ct = coefficients[:4]
            for mass, stiffness, damping in ((effective, kn, cn), (tangent, kt, ct)):
                if stiffness > 0:
                    bound = min(bound, .1 * np.sqrt(mass / stiffness))
                if damping > 0:
                    bound = min(bound, .1 * mass / damping)
        speed = np.linalg.norm(state["velocity"], axis=1).max()
        speed += np.max(np.linalg.norm(state["angularVelocity"], axis=1) * radii)
        speed += maximum * np.linalg.norm(model["gravity"])
        if speed:
            bound = min(bound, .1 * radii.min() / speed)
        return bound

    def __call__(self, state, maximum):
        dt = self.stable_step(state, maximum)
        model = self.model
        positions, velocity, omega = (np.asarray(state[name]) for name in
                                      ("positions", "velocity", "angularVelocity"))
        mass, radius, ids = model["mass"], model["radius"], model["particleIds"]
        force = mass[:, None] * model["gravity"]
        torque = np.zeros_like(force)
        history = {}
        previous_wall_contacts = {}
        for key, memory in state.get("contactHistory", {}).items():
            if key.startswith("w:"):
                particle_id = int(key.split(":", 2)[1])
                previous_wall_contacts.setdefault(particle_id, []).append((key, memory))
        dissipation = float(state.get("frictionDissipation", 0.0))
        tree = cKDTree(positions)
        pairs = sorted(tree.query_pairs(2 * radius.max()), key=lambda pair: tuple(sorted((int(ids[pair[0]]), int(ids[pair[1]])))))
        for first, second in pairs:
            if ids[first] > ids[second]:
                first, second = second, first
            displacement = positions[first] - positions[second]
            distance = np.linalg.norm(displacement)
            overlap = radius[first] + radius[second] - distance
            if overlap <= 0:
                continue
            if distance <= np.finfo(float).eps * (radius[first] + radius[second]):
                raise ValueError("DEM particle centers coincide")
            normal = displacement / distance
            arm_first = -normal * distance * radius[first] / (radius[first] + radius[second])
            arm_second = normal * distance * radius[second] / (radius[first] + radius[second])
            relative = velocity[first] + np.cross(omega[first], arm_first)
            relative -= velocity[second] + np.cross(omega[second], arm_second)
            key = f"p:{int(ids[first])}:{int(ids[second])}"
            materials = sorted((int(model["materialIndices"][first]), int(model["materialIndices"][second])))
            coefficients = model["coefficients"][f"{materials[0]}:{materials[1]}"]
            applied, memory, lost = contact_force(normal, overlap, relative, coefficients,
                                                 state.get("contactHistory", {}).get(key), dt)
            force[first] += applied
            force[second] -= applied
            torque[first] += np.cross(arm_first, applied)
            torque[second] += np.cross(arm_second, -applied)
            history[key] = memory
            dissipation += lost
        for wall in self.walls:
            for index, position in enumerate(positions):
                contacts = wall["query"].contacts(position, radius[index])
                prefix = f"w:{int(ids[index])}:{wall['id']}:"
                previous_contacts = {key: memory for key, memory in previous_wall_contacts.get(int(ids[index]), ())
                                     if key.startswith(prefix)}
                current_keys = {f"{prefix}{contact[-1]}" for contact in contacts}
                consumed = set()
                for point, distance, outward, feature in contacts:
                    offset = position - point
                    if np.dot(offset, outward) < -1e-10 * radius[index]:
                        raise ValueError("DEM particle center entered a fixed wall")
                    normal = offset / distance if distance > radius[index] * 1e-12 else outward
                    arm = point - position
                    relative = velocity[index] + np.cross(omega[index], arm)
                    key = f"{prefix}{feature}"
                    previous_key = None
                    best = float("inf")
                    for candidate_key, memory in previous_contacts.items():
                        if candidate_key in consumed or (candidate_key != key and candidate_key in current_keys):
                            continue
                        if np.dot(memory["normal"], normal) < .5:
                            continue
                        travel = np.linalg.norm(np.asarray(memory.get("point", point)) - point)
                        if travel > .25 * radius[index]:
                            continue
                        score = -1.0 if candidate_key == key else travel
                        if score < best:
                            previous_key, best = candidate_key, score
                    if previous_key is not None:
                        consumed.add(previous_key)
                    materials = sorted((int(model["materialIndices"][index]), wall["materialIndex"]))
                    coefficients = model["coefficients"][f"{materials[0]}:{materials[1]}"]
                    applied, memory, lost = contact_force(normal, radius[index] - distance, relative,
                                                         coefficients, previous_contacts.get(previous_key), dt)
                    force[index] += applied
                    torque[index] += np.cross(arm, applied)
                    # Match continuous contact across adjacent features one-to-one;
                    # two distinct concave contacts must retain separate springs.
                    history[key] = {**memory, "point": point.copy()}
                    dissipation += lost
        next_velocity = velocity + dt * force / mass[:, None]
        next_omega = omega + dt * torque / model["inertia"][:, None]
        return {"positions": positions + dt * next_velocity, "velocity": next_velocity,
                "angularVelocity": next_omega, "contactHistory": history,
                "frictionDissipation": dissipation}, dt


def contact_force(normal, overlap, relative, coefficients, previous, dt):
    kn, kt, cn, ct, static, dynamic = coefficients
    normal_speed = float(np.dot(relative, normal))
    magnitude = max(0.0, kn * overlap - cn * normal_speed)
    tangent_speed = relative - normal_speed * normal
    displacement = np.zeros(3) if previous is None else np.asarray(previous["displacement"]).copy()
    if previous is not None:
        old_normal = np.asarray(previous["normal"])
        axis = np.cross(old_normal, normal)
        cosine = float(np.clip(np.dot(old_normal, normal), -1, 1))
        if cosine > -1 + 1e-10:
            displacement += np.cross(axis, displacement) + np.cross(axis, np.cross(axis, displacement)) / (1 + cosine)
        else:
            displacement[:] = 0
    displacement -= np.dot(displacement, normal) * normal
    displacement += dt * tangent_speed
    trial_displacement = displacement.copy()
    tangential = -kt * displacement - ct * tangent_speed
    length = np.linalg.norm(tangential)
    if length > static * magnitude:
        speed = np.linalg.norm(tangent_speed)
        tangential = (-dynamic * magnitude * tangent_speed / speed if speed > 1e-14
                      else tangential * (dynamic * magnitude / length))
        displacement = -(tangential + ct * tangent_speed) / kt if kt > 0 else np.zeros(3)
    # Spring work is recoverable energy, not frictional dissipation. Slip is
    # the tangential increment removed by the Coulomb return to the limit.
    loss = (ct * float(np.dot(tangent_speed, tangent_speed)) * dt
            + kt * float(np.dot(displacement, trial_displacement - displacement))
            if kt > 0 else -float(np.dot(tangential, tangent_speed)) * dt)
    loss = max(0.0, loss)
    return magnitude * normal + tangential, {"normal": normal.copy(), "displacement": displacement}, loss
