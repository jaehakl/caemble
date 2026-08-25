from __future__ import annotations

import cmath
import math
from typing import Any

import numpy as np


VACUUM_LIGHT_SPEED = 299_792_458.0


def unit_vector(value: Any, path: str = "vector") -> np.ndarray[Any, Any]:
    vector = np.asarray(value, dtype=np.float64)
    if vector.shape != (3,) or np.any(~np.isfinite(vector)):
        raise ValueError(f"{path} must contain three finite values")
    length = float(np.linalg.norm(vector))
    if length <= 0:
        raise ValueError(f"{path} must be non-zero")
    return vector / length


def perpendicular(direction: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
    candidate = np.array([0.0, 0.0, 1.0])
    if abs(float(np.dot(candidate, direction))) > 0.9:
        candidate = np.array([0.0, 1.0, 0.0])
    return unit_vector(candidate - direction * float(np.dot(candidate, direction)))


def reflect(direction: np.ndarray[Any, Any], normal: np.ndarray[Any, Any]) -> np.ndarray[Any, Any]:
    return unit_vector(direction - 2 * float(np.dot(direction, normal)) * normal)


def refract(
    direction: np.ndarray[Any, Any],
    interface_normal: np.ndarray[Any, Any],
    n_incident: float,
    n_transmitted: float,
) -> np.ndarray[Any, Any] | None:
    cosine = -float(np.dot(direction, interface_normal))
    ratio = n_incident / n_transmitted
    sine_squared = ratio * ratio * max(0.0, 1.0 - cosine * cosine)
    if sine_squared > 1.0:
        return None
    return unit_vector(ratio * direction + (ratio * cosine - math.sqrt(max(0.0, 1.0 - sine_squared))) * interface_normal)


def _complex_cosine(n_incident: complex, n_transmitted: complex, cosine_incident: float) -> complex:
    sine_squared = max(0.0, 1.0 - cosine_incident * cosine_incident)
    cosine = cmath.sqrt(1 - (n_incident / n_transmitted) ** 2 * sine_squared)
    wavevector = n_transmitted * cosine
    if wavevector.real < 0 or (abs(wavevector.real) <= 1e-15 and wavevector.imag > 0):
        cosine = -cosine
    return cosine


def _passive_pair(reflection: complex, transmission: complex) -> tuple[complex, complex]:
    total = abs(reflection) ** 2 + abs(transmission) ** 2
    if not math.isfinite(total):
        raise ValueError("optical amplitudes must be finite")
    if total > 1:
        scale = 1 / math.sqrt(total)
        return reflection * scale, transmission * scale
    return reflection, transmission


def fresnel_amplitudes(
    n_incident: complex,
    n_transmitted: complex,
    cosine_incident: float,
) -> tuple[complex, complex, complex, complex]:
    cosine_incident = min(1.0, max(0.0, cosine_incident))
    cosine_transmitted = _complex_cosine(n_incident, n_transmitted, cosine_incident)
    s_denominator = n_incident * cosine_incident + n_transmitted * cosine_transmitted
    p_denominator = n_transmitted * cosine_incident + n_incident * cosine_transmitted
    if abs(s_denominator) == 0 or abs(p_denominator) == 0:
        return -1 + 0j, 1 + 0j, 0j, 0j
    reflection_s = (n_incident * cosine_incident - n_transmitted * cosine_transmitted) / s_denominator
    reflection_p = (n_transmitted * cosine_incident - n_incident * cosine_transmitted) / p_denominator
    transmission_s = 2 * n_incident * cosine_incident / s_denominator
    transmission_p = 2 * n_incident * cosine_incident / p_denominator
    incident_flux = (n_incident * cosine_incident).real
    transmitted_flux = (n_transmitted * cosine_transmitted).real
    scale = math.sqrt(max(0.0, transmitted_flux / incident_flux)) if incident_flux > 0 else 0.0
    reflection_s, transmission_s = _passive_pair(reflection_s, transmission_s * scale)
    reflection_p, transmission_p = _passive_pair(reflection_p, transmission_p * scale)
    return reflection_s, reflection_p, transmission_s, transmission_p


def rotate_stokes(stokes: np.ndarray[Any, Any], angle: float) -> np.ndarray[Any, Any]:
    cosine = math.cos(2 * angle)
    sine = math.sin(2 * angle)
    intensity, q_value, u_value, v_value = stokes
    return np.array(
        [
            intensity,
            q_value * cosine + u_value * sine,
            -q_value * sine + u_value * cosine,
            v_value,
        ],
        dtype=np.float64,
    )


def apply_diagonal_jones(
    stokes: np.ndarray[Any, Any],
    first: complex,
    second: complex,
) -> np.ndarray[Any, Any]:
    first_power = abs(first) ** 2
    second_power = abs(second) ** 2
    cross = first * second.conjugate()
    intensity, q_value, u_value, v_value = stokes
    return np.array(
        [
            0.5 * ((first_power + second_power) * intensity + (first_power - second_power) * q_value),
            0.5 * ((first_power - second_power) * intensity + (first_power + second_power) * q_value),
            cross.real * u_value - cross.imag * v_value,
            cross.imag * u_value + cross.real * v_value,
        ],
        dtype=np.float64,
    )


def polarization_basis_change(
    stokes: np.ndarray[Any, Any],
    basis: np.ndarray[Any, Any],
    direction: np.ndarray[Any, Any],
    first_axis: np.ndarray[Any, Any],
) -> np.ndarray[Any, Any]:
    cosine = min(1.0, max(-1.0, float(np.dot(basis, first_axis))))
    sine = float(np.dot(np.cross(basis, first_axis), direction))
    return rotate_stokes(stokes, math.atan2(sine, cosine))


def interface_stokes(
    stokes: np.ndarray[Any, Any],
    basis: np.ndarray[Any, Any],
    direction: np.ndarray[Any, Any],
    normal: np.ndarray[Any, Any],
    n_incident: complex,
    n_transmitted: complex,
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any], np.ndarray[Any, Any]]:
    s_axis = np.cross(direction, normal)
    if float(np.linalg.norm(s_axis)) <= 1e-14:
        s_axis = basis
    s_axis = unit_vector(s_axis)
    local = polarization_basis_change(stokes, basis, direction, s_axis)
    cosine = max(0.0, -float(np.dot(direction, normal)))
    reflection_s, reflection_p, transmission_s, transmission_p = fresnel_amplitudes(
        n_incident,
        n_transmitted,
        cosine,
    )
    reflected = apply_diagonal_jones(local, reflection_s, reflection_p)
    transmitted = apply_diagonal_jones(local, transmission_s, transmission_p)
    return reflected, transmitted, s_axis


def multilayer_amplitudes(
    n_incident: complex,
    layers: list[tuple[complex, float]],
    n_transmitted: complex,
    wavelength: float,
    cosine_incident: float,
) -> tuple[complex, complex, complex, complex]:
    if not layers:
        return fresnel_amplitudes(n_incident, n_transmitted, cosine_incident)
    sine_incident = math.sqrt(max(0.0, 1.0 - cosine_incident * cosine_incident))

    def solve(polarization: str) -> tuple[complex, complex]:
        invariant = n_incident * sine_incident

        def cosine(index: complex) -> complex:
            value = cmath.sqrt(1 - (invariant / index) ** 2)
            wavevector = index * value
            return (
                -value
                if wavevector.real < 0 or (abs(wavevector.real) <= 1e-15 and wavevector.imag > 0)
                else value
            )

        def admittance(index: complex, cosine_value: complex) -> complex:
            return index * cosine_value if polarization == "s" else cosine_value / index

        def interface(left: complex, right: complex) -> tuple[complex, complex, complex, complex]:
            denominator = left + right
            return (
                (left - right) / denominator,
                2 * right / denominator,
                2 * left / denominator,
                (right - left) / denominator,
            )

        def cascade(
            left: tuple[complex, complex, complex, complex],
            right: tuple[complex, complex, complex, complex],
        ) -> tuple[complex, complex, complex, complex]:
            denominator = 1 - left[3] * right[0]
            return (
                left[0] + left[1] * right[0] * left[2] / denominator,
                left[1] * right[1] / denominator,
                right[2] * left[2] / denominator,
                right[3] + right[2] * left[3] * right[1] / denominator,
            )

        incident_cosine = complex(cosine_incident)
        indices = [n_incident, *(index for index, _thickness in layers), n_transmitted]
        cosines = [incident_cosine, *(cosine(index) for index, _thickness in layers), cosine(n_transmitted)]
        admittances = [admittance(index, value) for index, value in zip(indices, cosines, strict=True)]
        scattering = interface(admittances[0], admittances[1])
        for layer_index, (index, thickness) in enumerate(layers, start=1):
            phase = 2 * math.pi * index * cosines[layer_index] * thickness / wavelength
            propagation = cmath.exp(-1j * phase)
            scattering = cascade(scattering, (0j, propagation, propagation, 0j))
            scattering = cascade(
                scattering,
                interface(admittances[layer_index], admittances[layer_index + 1]),
            )
        reflection = scattering[0]
        transmission = scattering[2]
        incident_admittance = admittances[0]
        transmitted_admittance = admittances[-1]
        incident_flux = incident_admittance.real
        transmitted_flux = transmitted_admittance.real
        scale = math.sqrt(max(0.0, transmitted_flux / incident_flux)) if incident_flux > 0 else 0.0
        return _passive_pair(reflection, transmission * scale)

    reflection_s, transmission_s = solve("s")
    reflection_p, transmission_p = solve("p")
    return reflection_s, reflection_p, transmission_s, transmission_p


def multilayer_stokes(
    stokes: np.ndarray[Any, Any],
    basis: np.ndarray[Any, Any],
    direction: np.ndarray[Any, Any],
    normal: np.ndarray[Any, Any],
    n_incident: complex,
    layers: list[tuple[complex, float]],
    n_transmitted: complex,
    wavelength: float,
) -> tuple[np.ndarray[Any, Any], np.ndarray[Any, Any], np.ndarray[Any, Any]]:
    s_axis = np.cross(direction, normal)
    if float(np.linalg.norm(s_axis)) <= 1e-14:
        s_axis = basis
    s_axis = unit_vector(s_axis)
    local = polarization_basis_change(stokes, basis, direction, s_axis)
    amplitudes = multilayer_amplitudes(
        n_incident,
        layers,
        n_transmitted,
        wavelength,
        max(0.0, -float(np.dot(direction, normal))),
    )
    reflected = apply_diagonal_jones(local, amplitudes[0], amplitudes[1])
    transmitted = apply_diagonal_jones(local, amplitudes[2], amplitudes[3])
    return reflected, transmitted, s_axis


def cosine_hemisphere(normal: np.ndarray[Any, Any], first: float, second: float) -> np.ndarray[Any, Any]:
    radius = math.sqrt(first)
    angle = 2 * math.pi * second
    tangent = perpendicular(normal)
    bitangent = np.cross(normal, tangent)
    return unit_vector(
        tangent * (radius * math.cos(angle))
        + bitangent * (radius * math.sin(angle))
        + normal * math.sqrt(max(0.0, 1.0 - first))
    )


def cone_direction(
    axis: np.ndarray[Any, Any],
    half_angle: float,
    first: float,
    second: float,
) -> np.ndarray[Any, Any]:
    if half_angle <= 0:
        return axis.copy()
    cosine = 1 - first * (1 - math.cos(half_angle))
    sine = math.sqrt(max(0.0, 1 - cosine * cosine))
    azimuth = 2 * math.pi * second
    tangent = perpendicular(axis)
    bitangent = np.cross(axis, tangent)
    return unit_vector(axis * cosine + tangent * sine * math.cos(azimuth) + bitangent * sine * math.sin(azimuth))


def henyey_greenstein(
    direction: np.ndarray[Any, Any],
    anisotropy: float,
    first: float,
    second: float,
) -> np.ndarray[Any, Any]:
    if abs(anisotropy) < 1e-12:
        cosine = 1 - 2 * first
    else:
        ratio = (1 - anisotropy * anisotropy) / (1 - anisotropy + 2 * anisotropy * first)
        cosine = (1 + anisotropy * anisotropy - ratio * ratio) / (2 * anisotropy)
        cosine = min(1.0, max(-1.0, cosine))
    sine = math.sqrt(max(0.0, 1 - cosine * cosine))
    azimuth = 2 * math.pi * second
    tangent = perpendicular(direction)
    bitangent = np.cross(direction, tangent)
    return unit_vector(direction * cosine + tangent * sine * math.cos(azimuth) + bitangent * sine * math.sin(azimuth))


def abg_direction(
    specular: np.ndarray[Any, Any],
    normal: np.ndarray[Any, Any],
    b_value: float,
    g_value: float,
    first: float,
    second: float,
) -> np.ndarray[Any, Any]:
    exponent = max(1e-6, g_value)
    tangent_squared = b_value * ((1 - first) ** (-1 / exponent) - 1)
    tangent = min(1e6, math.sqrt(max(0.0, tangent_squared)))
    cosine = 1 / math.sqrt(1 + tangent * tangent)
    sine = tangent * cosine
    azimuth = 2 * math.pi * second
    first_axis = perpendicular(specular)
    second_axis = np.cross(specular, first_axis)
    result = unit_vector(specular * cosine + first_axis * sine * math.cos(azimuth) + second_axis * sine * math.sin(azimuth))
    return result if float(np.dot(result, normal)) > 0 else reflect(result, normal)
