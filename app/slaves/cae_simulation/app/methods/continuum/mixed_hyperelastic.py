"""Independent F/q response of the logarithmic Neo-Hookean mixed potential."""

from dataclasses import dataclass

import numpy as np

from .hyperelastic import InvalidDeformationError


@dataclass(frozen=True)
class MixedHyperelasticResponse:
    potential: np.ndarray
    strain_energy: np.ndarray
    equilibrium_energy: np.ndarray
    piola: np.ndarray
    cauchy: np.ndarray
    volume_residual: np.ndarray
    coupling: np.ndarray
    compliance: np.ndarray
    tangent: np.ndarray | None


def mixed_neo_hookean(deformation, auxiliary_pressure, shear, lame, *, tangent=False):
    """Differentiate Psi(F,q), holding q fixed in dP/dF.

    q has pressure units but is not -trace(sigma)/3. The constitutive energy W(F)
    and the discrete equilibrium energy are deliberately separate quantities.
    Tensor rows refer to current Cartesian axes and columns to reference axes.
    """
    deformation = np.asarray(deformation, dtype=float)
    q, shear, lame = map(np.asarray, (auxiliary_pressure, shear, lame))
    if deformation.shape[-2:] != (3, 3):
        raise ValueError("mixed Neo-Hookean deformation requires full 3 by 3 matrices")
    if not all(np.all(np.isfinite(value)) and np.all(value > 0) for value in (shear, lame)):
        raise ValueError("mixed Neo-Hookean requires finite positive shear and Lame lambda")
    jacobian = np.linalg.det(deformation)
    if (not np.all(np.isfinite(deformation)) or not np.all(np.isfinite(q))
            or not np.all(np.isfinite(jacobian)) or np.any(jacobian <= 0)):
        raise InvalidDeformationError("mixed Neo-Hookean requires finite F/q and positive J")
    try:
        inverse = np.linalg.inv(deformation).swapaxes(-1, -2)
    except np.linalg.LinAlgError as error:
        raise InvalidDeformationError("mixed Neo-Hookean deformation is singular") from error
    logarithm = np.log(jacobian)
    base = .5 * shear * (np.sum(deformation**2, axis=(-1, -2)) - 3) - shear * logarithm
    piola = shear[..., None, None] * deformation + (q - shear)[..., None, None] * inverse
    cauchy = piola @ deformation.swapaxes(-1, -2) / jacobian[..., None, None]
    derivative = None
    if tangent:
        derivative = (shear[..., None, None, None, None] * np.einsum("ik,JL->iJkL", np.eye(3), np.eye(3))
                      - (q - shear)[..., None, None, None, None] * np.einsum("...iL,...kJ->...iJkL", inverse, inverse))
    result = MixedHyperelasticResponse(
        base + q * logarithm - .5 * q**2 / lame,
        base + .5 * lame * logarithm**2, base + .5 * q**2 / lame,
        piola, cauchy, logarithm - q / lame, inverse, -1 / lame, derivative,
    )
    if any(value is not None and not np.all(np.isfinite(value)) for value in vars(result).values()):
        raise InvalidDeformationError("mixed Neo-Hookean response is nonfinite")
    return result
