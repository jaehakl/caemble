"""Total Lagrangian tet4 solids; all element unknowns are translations."""

import numpy as np

from app.methods.continuum.hyperelastic import neo_hookean
from app.methods.finite_element.integration import integration_points


def prepare_tet4(points, material):
    quadrature = integration_points("tet4", points)
    volume = sum(weight for _, weight, _ in quadrature)
    gradients = quadrature[0][2]
    mass = material["density"] * volume / 20 * np.kron(np.ones((4, 4)) + np.eye(4), np.eye(3))
    data = {"gradients": gradients, "referenceVolume": volume, "M": mass}
    data["K"] = tet4_response(np.zeros((4, 3)), material, data)[1]
    return data


def tet4_response(displacement, material, prepared, *, tangent=True):
    gradients, volume = prepared["gradients"], prepared["referenceVolume"]
    deformation = np.eye(3) + np.asarray(displacement).T @ gradients
    response = neo_hookean(deformation, material["shear"], material["lame"], tangent=tangent)
    force = volume * (gradients @ response.piola.T).ravel()
    stiffness = (volume * np.einsum("aJ,iJkL,bL->aibk", gradients, response.tangent, gradients).reshape(12, 12)
                 if tangent else np.zeros((12, 12)))
    stress = response.cauchy[(0, 1, 2, 0, 1, 0), (0, 1, 2, 1, 2, 2)][None, :]
    return force, stiffness, float(volume * response.energy), stress
