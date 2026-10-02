"""Physical motion waveforms, interpolation and initial motion."""

import numpy as np

from app.kernel.api import BundleValue

from ..clock import clock_tolerance
from ..constraints import enforce_links, revolute_joints
from ..continuum import physical_angular_velocities, physical_orientation_matrices
from ..domain import parameter
from ..kinematics import kinematic_rates
from app.methods.rigid.rotations import rotation_exp, rotation_exp_many, rotation_log_many
from ..rotor import initialize_rotor
from ..state import append_history, initial_solution


def interpolate(times, values, time):
    if len(times) == 1:
        return np.asarray(values[0])
    right = int(np.clip(np.searchsorted(times, time), 1, len(times) - 1))
    fraction = (time - times[right - 1]) / (times[right] - times[right - 1])
    return (1 - fraction) * values[right - 1] + fraction * values[right]


def interpolate_orientations(times, values, time):
    """두 자세 사이의 가장 짧은 SO(3) 경로를 보간한다.

    adaptive substep이 파형 표본 사이에 있어도 직교 회전행렬을 유지한다.
    행렬 성분의 선형 보간은 회전행렬이 아니므로 사용하지 않는다.
    """
    right = int(np.clip(np.searchsorted(times, time), 1, len(times) - 1))
    if time == times[right]:
        return np.asarray(values[right]).copy()
    fraction = (time - times[right - 1]) / (times[right] - times[right - 1])
    left, right_rotation = np.asarray(values[right - 1]), np.asarray(values[right])
    relative = rotation_log_many(right_rotation @ left.transpose(0, 2, 1))
    return rotation_exp_many(fraction * relative) @ left


def initialize_motion(model, initializations):
    solution = initial_solution(model)
    for rule in initializations:
        if rule["methodId"] == "fea.initial-motion":
            p = rule["parameters"]
            velocity = np.asarray(parameter(p["initialVelocity"]))
            angular = np.asarray(parameter(p["initialAngularVelocity"]))
            if model.physical_node_count is None:
                solution.velocity[:, :3] = velocity
                solution.velocity[:, 3:] = angular
                continue
            selected = np.unique(np.concatenate([model.cell_regions[target] for target in rule["target"]]))
            nodes = np.unique(np.concatenate([model.elements[index].nodes for index in selected]))
            reference = np.asarray(parameter(p["referencePoint"]))
            solution.velocity[nodes, :3] = velocity + np.cross(angular, model.points[nodes] - reference)
            solution.velocity[nodes, 3:] = angular
            for target, node in model.provenance.get("auxiliaryNodes", {}).items():
                if np.isin(model.boundary_regions[target]["nodes"], nodes).all():
                    solution.velocity[node, :3] = velocity + np.cross(angular, model.points[node] - reference)
                    solution.velocity[node, 3:] = angular
    pitch = initialize_rotor(model, solution)
    enforce_links(model, solution.displacement, solution.orientations, pitch)
    append_history(model, solution, pitch)
    return solution


def motion_from_samples(model, samples, pitches, iteration):
    interface = interface_members(model)
    frames = interface["referenceOrientations"]
    rotor_speeds = np.zeros(len(samples))
    generator_speeds = np.zeros(len(samples))
    if model.rotor is not None:
        r = model.rotor
        rotor_speeds = np.array([s.orientations[r["nacelleNode"]][:, 0] @ (s.velocity[r["hubNode"], 3:] - s.velocity[r["nacelleNode"], 3:]) for s in samples])
        generator_speeds = np.array([s.orientations[r["nacelleNode"]][:, 0] @ (s.velocity[r["generatorNode"], 3:] - s.velocity[r["nacelleNode"], 3:]) for s in samples])
    return {"modelIdentity": model.identity, "nodeIds": model.node_ids.astype(np.int32), "times": np.asarray([s.time for s in samples], dtype=float), "positions": np.asarray([model.points + s.displacement[:, :3] for s in samples]), "orientations": np.asarray([physical_orientation_matrices(model, s.displacement, s.orientations) @ frames for s in samples]), "velocities": np.asarray([s.velocity[:, :3] for s in samples]), "angularVelocities": np.asarray([physical_angular_velocities(model, s.displacement, s.velocity) for s in samples]), "accelerations": np.asarray([s.acceleration[:, :3] for s in samples]), "rotorSpeed": rotor_speeds, "generatorSpeed": generator_speeds, "pitch": np.asarray(pitches, dtype=float), "couplingIteration": np.asarray(iteration, dtype=np.int32)}


def predict_motion(model, solution, settings):
    from copy import copy
    interval = min(settings["windowSize"], max(settings["duration"] - solution.time, 0.0))
    if interval <= clock_tolerance(settings):
        interval = 0.0
    count = max(1, int(np.ceil(interval / settings["dt"])))
    samples = []
    pitch = 0 if not solution.history else float(solution.history["pitch"][-1][-1])
    for delta in ([0.0] if interval == 0 else np.linspace(0, interval, count + 1)):
        candidate = copy(solution)
        candidate.time = solution.time + delta
        candidate.displacement = solution.displacement + delta * solution.velocity + 0.5 * delta**2 * solution.acceleration
        joint_rates = {}
        for slave, (master, axis_index) in revolute_joints(model).items():
            axis = solution.orientations[master][:, axis_index]
            rate = axis @ (solution.velocity[slave, 3:] - solution.velocity[master, 3:])
            second_rate = axis @ (solution.acceleration[slave, 3:] - solution.acceleration[master, 3:])
            candidate.displacement[slave, 3 + axis_index] = solution.displacement[slave, 3 + axis_index] + delta * rate + .5 * delta**2 * second_rate
            joint_rates[slave] = (rate + delta * second_rate, second_rate)
        candidate.velocity = solution.velocity + delta * solution.acceleration
        candidate.orientations = np.asarray([rotation_exp(delta * v[3:] + 0.5 * delta**2 * a[3:]) @ R for v, a, R in zip(solution.velocity, solution.acceleration, solution.orientations)])
        enforce_links(model, candidate.displacement, candidate.orientations, pitch)
        candidate.velocity, candidate.acceleration, _, _ = kinematic_rates(model, candidate.orientations, candidate.velocity, solution.acceleration, joint_rates=joint_rates)
        samples.append(candidate)
    return BundleValue(
        "caemble.mechanics/motion@1",
        motion_from_samples(model, samples, [pitch] * len(samples), 0),
        interface_metadata(model),
    )


def interface_members(model):
    frames = np.tile(np.eye(3), (len(model.points), 1, 1))
    for element in model.elements:
        if element.kind == "beam2":
            frames[element.nodes] = element.section["frame"]
    return {"modelIdentity": model.identity, "nodeIds": model.node_ids.astype(np.int32), "referencePositions": model.points, "referenceOrientations": frames}


def interface_metadata(model):
    """Semantic physical regions and their optional opaque attachment IDs."""
    return {
        "regions": {
            name: model.node_ids[np.asarray(region["nodes"], dtype=int)].astype(np.int32)
            for name, region in model.boundary_regions.items()
        },
        "regionReferences": {
            target: int(model.node_ids[int(node)])
            for target, node in model.provenance.get("auxiliaryNodes", {}).items()
        },
    }
