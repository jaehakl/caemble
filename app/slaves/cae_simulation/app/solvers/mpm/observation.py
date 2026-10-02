"""Passive material observations, including interpolation within GL+(3)."""

import numpy as np
from scipy.spatial.transform import Rotation

from app.methods.continuum.hyperelastic import neo_hookean


def observe(state, model):
    settings = model["settings"]
    deformation = state["deformationGradient"]
    response = neo_hookean(deformation, settings["shear"], settings["lame"])
    jacobian = np.linalg.det(deformation)
    return {"positions": state["positions"], "velocity": state["velocity"],
            "displacement": state["positions"] - model["referencePositions"],
            "deformationGradient": deformation, "stress": response.cauchy,
            "firstPiolaStress": response.piola, "volumeRatio": jacobian,
            "strainEnergyDensity": response.energy, "density": settings["density"] / jacobian}


def interpolate(previous, following, fraction, model):
    if fraction == 0:
        return previous
    if fraction == 1:
        return following
    rotations, logarithms = [], []
    for endpoint in (previous, following):
        left, stretch, right = np.linalg.svd(endpoint["deformationGradient"])
        rotations.append(left @ right)
        logarithms.append(np.einsum("...ji,...j,...jk->...ik", right, np.log(stretch), right))
    relative = rotations[0].swapaxes(-1, -2) @ rotations[1]
    rotation = rotations[0] @ Rotation.from_rotvec(fraction * Rotation.from_matrix(relative).as_rotvec()).as_matrix()
    eigenvalues, vectors = np.linalg.eigh((1 - fraction) * logarithms[0] + fraction * logarithms[1])
    stretch = np.einsum("...ij,...j,...kj->...ik", vectors, np.exp(eigenvalues), vectors)
    state = {name: previous[name] + fraction * (following[name] - previous[name]) for name in ("positions", "velocity")}
    state["deformationGradient"] = rotation @ stretch
    return observe(state, model)
