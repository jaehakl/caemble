"""Initial rotor kinematics, independent of waveform transport and integration."""

import numpy as np

from app.methods.rigid.rotations import rotation_exp


def initialize_rotor(model, solution):
    pitch = 0.0
    if model.rotor is not None:
        rotor = model.rotor
        hub, generator = rotor["hubNode"], rotor["generatorNode"]
        angle, speed, pitch = rotor["initialAzimuth"], rotor["initialRotorSpeed"], rotor["initialPitch"]
        rotation = rotation_exp(np.array([angle, 0.0, 0.0]))
        solution.orientations[hub] = rotation
        solution.displacement[hub, 3] = angle
        solution.velocity[hub, 3] = speed
        solution.displacement[generator, 3] = angle * rotor["gearRatio"]
        solution.orientations[generator] = rotation_exp(np.array([angle * rotor["gearRatio"], 0, 0]))
        solution.velocity[generator, 3] = speed * rotor["gearRatio"]
        for name, center, ratio in (("hubBodyNodes", hub, 1.), ("generatorBodyNodes", generator, rotor["gearRatio"])):
            nodes = rotor.get(name, ())
            for node in nodes:
                position = model.points[center] + solution.orientations[center] @ (model.points[node] - model.points[center])
                solution.displacement[node, :3] = position - model.points[node]
                solution.orientations[node] = solution.orientations[center]
                solution.velocity[node, :3] = np.cross([speed * ratio, 0, 0], position - model.points[center])
                solution.velocity[node, 3:] = [speed * ratio, 0, 0]
                solution.acceleration[node, :3] = np.cross([speed * ratio, 0, 0], solution.velocity[node, :3])
        for root, nodes in zip(rotor["bladeRootNodes"], rotor["bladeNodeIds"]):
            span = model.points[root] - model.points[hub]
            span /= np.linalg.norm(span)
            pitch_rotation = rotation_exp(-span * pitch)
            for node in nodes:
                reference = model.points[node]
                if model.physical_node_count is not None:
                    reference = model.points[root] + pitch_rotation @ (reference - model.points[root])
                position = model.points[hub] + rotation @ (reference - model.points[hub])
                solution.displacement[node, :3] = position - model.points[node]
                solution.displacement[node, 3:] = [angle, 0, 0]
                solution.orientations[node] = rotation @ pitch_rotation
                solution.velocity[node, :3] = np.cross([speed, 0, 0], position - model.points[hub])
                solution.velocity[node, 3:] = [speed, 0, 0]
                solution.acceleration[node, :3] = np.cross([speed, 0, 0], solution.velocity[node, :3])
    return pitch
