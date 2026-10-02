"""Compressible Neo-Hookean response in fixed reference/current Cartesian frames."""

from dataclasses import dataclass

import numpy as np


class InvalidDeformationError(ValueError):
    """A numerical trial has left the orientation-preserving material domain."""


@dataclass(frozen=True)
class HyperelasticResponse:
    energy: np.ndarray
    piola: np.ndarray
    cauchy: np.ndarray
    tangent: np.ndarray | None = None


def neo_hookean(deformation, shear, lame, *, tangent=False):
    """Evaluate W, P=dW/dF, sigma=P F.T/J and optional A[i,J,k,L]=dP/dF.

    W = mu/2 (F:F - 3) - mu log(J) + lambda/2 log(J)^2.
    F and P have current rows and reference columns. Coefficients can be scalars
    or arrays matching the leading material-point dimensions of F.
    """
    deformation = np.asarray(deformation, dtype=float)
    if deformation.shape[-2:] != (3, 3):
        raise ValueError("Neo-Hookean deformation requires full 3 by 3 matrices")
    shear, lame = np.asarray(shear), np.asarray(lame)
    if (not np.all(np.isfinite(shear)) or not np.all(np.isfinite(lame))
            or np.any(shear <= 0) or np.any(lame + 2 * shear / 3 <= 0)):
        raise ValueError("Neo-Hookean requires finite positive shear and bulk moduli")
    jacobian = np.linalg.det(deformation)
    if np.any(jacobian <= 0) or not np.all(np.isfinite(deformation)) or not np.all(np.isfinite(jacobian)):
        raise InvalidDeformationError("Neo-Hookean deformation requires finite positive J")
    logarithm = np.log(jacobian)
    try:
        inverse = np.linalg.inv(deformation).swapaxes(-1, -2)
    except np.linalg.LinAlgError as error:
        raise InvalidDeformationError("Neo-Hookean deformation is numerically singular") from error
    coefficient = lame * logarithm - shear
    piola = shear[..., None, None] * deformation + coefficient[..., None, None] * inverse
    cauchy = (piola @ deformation.swapaxes(-1, -2)) / jacobian[..., None, None]
    energy = .5 * shear * (np.sum(deformation**2, axis=(-1, -2)) - 3) - shear * logarithm + .5 * lame * logarithm**2
    derivative = None
    if tangent:
        derivative = (
            shear[..., None, None, None, None] * np.einsum("ik,JL->iJkL", np.eye(3), np.eye(3))
            + lame[..., None, None, None, None] * np.einsum("...iJ,...kL->...iJkL", inverse, inverse)
            - coefficient[..., None, None, None, None] * np.einsum("...iL,...kJ->...iJkL", inverse, inverse)
        )
    if (not all(np.all(np.isfinite(value)) for value in (energy, piola, cauchy))
            or (derivative is not None and not np.all(np.isfinite(derivative)))):
        raise InvalidDeformationError("Neo-Hookean response is nonfinite")
    return HyperelasticResponse(energy, piola, cauchy, derivative)
