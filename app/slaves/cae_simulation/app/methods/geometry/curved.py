"""The CurvedEdgeCylinder radius definition shared by meshes and rays."""

from .interval import cos, sin


def curved_radius(parameters, z, theta):
    curve = parameters["verticalCurve"]
    offset = z - curve["origin"]
    vertical, derivative = 0.0, 0.0
    for coefficient in reversed(curve["coefficients"]):
        derivative = derivative * offset + vertical
        vertical = vertical * offset + coefficient
    angular, angular_derivative = 0.0, 0.0
    for order, mode in enumerate(parameters["azimuthalCurve"]):
        angle = order * theta + mode["phase"]
        angular += mode["amplitude"] * cos(angle)
        angular_derivative -= order * mode["amplitude"] * sin(angle)
    return vertical * angular, derivative * angular, vertical * angular_derivative
