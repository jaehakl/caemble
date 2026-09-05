from __future__ import annotations

import math

import numpy as np


def diffracted_direction(
    direction: np.ndarray,
    normal: np.ndarray,
    groove: np.ndarray,
    wavelength: float,
    spacing: float,
    order: int,
) -> np.ndarray | None:
    """Reflect a ray using the tangential grating equation.

    The authored outward normal fixes the sign of the order: positive orders
    add wavelength / spacing along groove x normal. Wavelength is in the
    incident medium. Flipping the incident side changes only the outgoing
    normal component, not the authored order convention.
    """
    tangent = np.cross(groove, normal)
    tangential = direction - np.dot(direction, normal) * normal
    tangential = tangential + order * wavelength / spacing * tangent
    normal_squared = 1.0 - float(np.dot(tangential, tangential))
    if normal_squared < -1e-14:
        return None
    sign = 1.0 if np.dot(direction, normal) < 0 else -1.0
    return tangential + sign * math.sqrt(max(0.0, normal_squared)) * normal
