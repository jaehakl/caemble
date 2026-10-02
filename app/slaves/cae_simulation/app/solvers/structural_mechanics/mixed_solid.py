"""Total Lagrangian MINI element, with an explicit [u(12), q(4), bubble(3)] block."""

import numpy as np

from app.methods.continuum.hyperelastic import InvalidDeformationError
from app.methods.continuum.mixed_hyperelastic import mixed_neo_hookean
from app.methods.finite_element.tetrahedron import mini_shape, tetrahedron_quadrature


def prepare_mini(points, material, order=5):
    matrix = (points[1:] - points[0]).T
    determinant = np.linalg.det(matrix)
    if not np.isfinite(determinant) or determinant <= 0:
        raise ValueError("MINI requires a positively oriented reference tetrahedron")
    gradients = np.array([[-1., -1., -1.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]]) @ np.linalg.inv(matrix)
    barycentric, weights = tetrahedron_quadrature(order)
    values, all_gradients = mini_shape(barycentric, gradients)
    return {"gradients": gradients, "shape": values, "displacementGradients": all_gradients,
            "weights": weights * determinant, "referenceVolume": determinant / 6,
            "bodyWeights": weights @ values * determinant * material["density"]}


def mini_response(displacement, auxiliary_pressure, bubble, material, prepared, *, tangent=True):
    """Evaluate one element; leading dimensions may batch multiple elements."""
    gradients, weights = prepared["displacementGradients"], prepared["weights"]
    shape = prepared["shape"][..., :4]
    values = np.concatenate((displacement, bubble[..., None, :]), axis=-2)
    deformation = np.eye(3) + np.einsum("...ai,...gaJ->...giJ", values, gradients)
    q = np.einsum("...ga,...a->...g", shape, auxiliary_pressure)
    response = mixed_neo_hookean(deformation, q, material["shear"], material["lame"], tangent=tangent)
    force = np.einsum("...g,...gaJ,...giJ->...ai", weights, gradients, response.piola)
    constraint = np.einsum("...g,...ga,...g->...a", weights, shape, response.volume_residual)
    residual = np.concatenate((force[..., :4, :].reshape(*force.shape[:-2], 12), constraint, force[..., 4, :]), axis=-1)
    stiffness = None
    if tangent:
        # Contract one reference-coordinate index first. The four-factor
        # einsum optimizer otherwise keeps both in the expensive final loop.
        partial = np.einsum("...gaJ,...giJkL->...gaikL", gradients, response.tangent)
        uu = np.einsum("...g,...gaikL,...gbL->...aibk", weights, partial, gradients, optimize=True).reshape(*residual.shape[:-1], 15, 15)
        uq = np.einsum("...g,...gaJ,...giJ,...gb->...aib", weights, gradients, response.coupling, shape, optimize=True).reshape(*residual.shape[:-1], 15, 4)
        qq = np.einsum("...g,...ga,...gb->...ab", weights * response.compliance, shape, shape)
        full = np.concatenate((np.concatenate((uu, uq), axis=-1), np.concatenate((uq.swapaxes(-1, -2), qq), axis=-1)), axis=-2)
        order = np.r_[np.arange(12), np.arange(15, 19), np.arange(12, 15)]
        stiffness = full[..., order, :][..., :, order]
    energies = np.stack([np.sum(weights * value, axis=-1) for value in (response.potential, response.strain_energy, response.equilibrium_energy)], axis=-1)
    return residual, stiffness, energies, response.cauchy


def condense_bubble(residual, tangent):
    """Schur complement both residual and matrix; retain bubble recovery factors."""
    try:
        recovery = np.linalg.solve(tangent[..., 16:, 16:], np.concatenate((tangent[..., 16:, :16], residual[..., 16:, None]), axis=-1))
    except np.linalg.LinAlgError as error:
        raise InvalidDeformationError("MINI bubble tangent is singular at this trial") from error
    if not np.all(np.isfinite(recovery)):
        raise InvalidDeformationError("MINI bubble recovery is nonfinite")
    matrix = tangent[..., :16, :16] - tangent[..., :16, 16:] @ recovery[..., :16]
    force = residual[..., :16] - np.einsum("...ij,...j->...i", tangent[..., :16, 16:], recovery[..., 16])
    return force, matrix, recovery
