from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np
import torch

from app.runtime_kernel.api.units import convert_ucum_value

from .physics import EPSILON_0, ElectricUpdateCoefficients, transverse_edge_average


RELATIVE_PERMITTIVITY = "electrical.relative_permittivity"
DRUDE_EPSILON_INFINITY = "electrical.drude_infinite_frequency_relative_permittivity"
DRUDE_PLASMA_FREQUENCY = "electrical.drude_plasma_frequency"
DRUDE_COLLISION_FREQUENCY = "electrical.drude_collision_frequency"
DRUDE_PROPERTIES = (
    DRUDE_EPSILON_INFINITY,
    DRUDE_PLASMA_FREQUENCY,
    DRUDE_COLLISION_FREQUENCY,
)
MODEL_CODES = {"default": 0, "Drude_RC": 1, "Drude_TRC": 2}


@dataclass(frozen=True, slots=True)
class MaterialProperties:
    relative_permittivity: float
    epsilon_infinity: float | None
    plasma_frequency: float | None
    collision_frequency: float | None

    @property
    def has_drude(self) -> bool:
        return self.epsilon_infinity is not None


def material_properties(
    world: dict[str, Any],
    part: dict[str, Any],
    descriptor: dict[str, Any],
    *,
    source: str,
) -> MaterialProperties:
    material_name = part.get("material", {}).get("name")
    if not isinstance(material_name, str) or not material_name:
        raise ValueError(f"geometry {part.get('id')!r} must reference a Material")
    try:
        material = world["materials"][source]["parameters"]["materials"][material_name]
    except KeyError as error:
        raise ValueError(f"Material {material_name!r} is unavailable for {source} geometry") from error
    relative_permittivity = _isotropic_value(
        material,
        descriptor,
        material_name,
        RELATIVE_PERMITTIVITY,
    )
    present = [name in material for name in DRUDE_PROPERTIES]
    if any(present) and not all(present):
        missing = [name for name, exists in zip(DRUDE_PROPERTIES, present, strict=True) if not exists]
        raise ValueError(
            f"Material {material_name!r} defines only part of the Drude model; missing {missing!r}"
        )
    if not any(present):
        return MaterialProperties(relative_permittivity, None, None, None)
    epsilon_infinity = _isotropic_value(
        material,
        descriptor,
        material_name,
        DRUDE_EPSILON_INFINITY,
    )
    plasma_frequency = _scalar_value(
        material,
        descriptor,
        material_name,
        DRUDE_PLASMA_FREQUENCY,
    )
    collision_frequency = _scalar_value(
        material,
        descriptor,
        material_name,
        DRUDE_COLLISION_FREQUENCY,
    )
    if epsilon_infinity <= 0 or plasma_frequency <= 0 or collision_frequency <= 0:
        raise ValueError(f"Material {material_name!r} Drude values must all be positive")
    return MaterialProperties(
        relative_permittivity,
        epsilon_infinity,
        plasma_frequency,
        collision_frequency,
    )


def build_update_coefficients(
    relative_permittivity: np.ndarray[Any, np.dtype[np.float32]],
    epsilon_infinity: np.ndarray[Any, np.dtype[np.float32]],
    plasma_frequency: np.ndarray[Any, np.dtype[np.float32]],
    collision_frequency: np.ndarray[Any, np.dtype[np.float32]],
    model_codes: np.ndarray[Any, np.dtype[np.uint8]],
    dt: float,
    periodic: Sequence[bool],
    device: torch.device,
) -> ElectricUpdateCoefficients:
    arrays = (
        relative_permittivity,
        epsilon_infinity,
        plasma_frequency,
        collision_frequency,
        model_codes,
    )
    if any(array.shape != relative_permittivity.shape for array in arrays):
        raise ValueError("all FDTD material arrays must have the same shape")
    eps = torch.as_tensor(relative_permittivity, dtype=torch.float32, device=device)
    if torch.any(~torch.isfinite(eps)) or torch.any(eps <= 0):
        raise ValueError("relative permittivity must be positive and finite in every cell")
    has_drude = bool(
        np.any(
            (model_codes != 0)
            & np.isfinite(epsilon_infinity)
            & np.isfinite(plasma_frequency)
            & np.isfinite(collision_frequency)
        )
    )
    if not has_drude:
        if np.all(relative_permittivity == relative_permittivity.flat[0]):
            curl = torch.tensor(
                dt / (EPSILON_0 * float(relative_permittivity.flat[0])),
                dtype=torch.float32,
                device=device,
            )
            return ElectricUpdateCoefficients(None, curl, None, None, None, None)
        curl = torch.stack(
            [
                dt
                / (
                    EPSILON_0
                    * transverse_edge_average(eps, component, periodic)
                )
                for component in range(3)
            ]
        )
        return ElectricUpdateCoefficients(None, curl, None, None, None, None)

    eps_inf = torch.as_tensor(epsilon_infinity, dtype=torch.float32, device=device)
    plasma = torch.as_tensor(plasma_frequency, dtype=torch.float32, device=device)
    collision = torch.as_tensor(collision_frequency, dtype=torch.float32, device=device)
    models = torch.as_tensor(model_codes, dtype=torch.uint8, device=device)

    components: list[tuple[torch.Tensor, ...]] = []
    for component in range(3):
        eps_edge = transverse_edge_average(eps, component, periodic)
        drude_cell = (models != 0) & torch.isfinite(eps_inf) & torch.isfinite(plasma) & torch.isfinite(collision)
        metal_fraction = transverse_edge_average(drude_cell.to(torch.float32), component, periodic)
        weight = metal_fraction.clamp_min(torch.finfo(torch.float32).eps)
        eps_inf_edge = transverse_edge_average(
            torch.where(drude_cell, eps_inf, torch.zeros_like(eps_inf)),
            component,
            periodic,
        ) / weight
        omega_p = 2.0 * math.pi * transverse_edge_average(
            torch.where(drude_cell, plasma, torch.zeros_like(plasma)),
            component,
            periodic,
        ) / weight
        omega_c = 2.0 * math.pi * transverse_edge_average(
            torch.where(drude_cell, collision, torch.zeros_like(collision)),
            component,
            periodic,
        ) / weight
        eps_inf_edge = torch.where(metal_fraction > 0, eps_inf_edge, torch.ones_like(eps_inf_edge))
        omega_p = torch.where(metal_fraction > 0, omega_p, torch.ones_like(omega_p))
        omega_c = torch.where(metal_fraction > 0, omega_c, torch.ones_like(omega_c))
        decay = torch.exp(-omega_c * dt)
        chi0 = omega_p.square() * dt / omega_c - (
            omega_p / omega_c
        ).square() * (1.0 - decay)
        dchi0 = -((omega_p / omega_c) * (1.0 - decay)).square()

        default_curl = dt / (EPSILON_0 * eps_edge)
        rc_fraction = transverse_edge_average(
            ((models == 1) & drude_cell).to(torch.float32), component, periodic
        )
        trc_fraction = transverse_edge_average(
            ((models == 2) & drude_cell).to(torch.float32), component, periodic
        )
        dispersive_fraction = torch.clamp(rc_fraction + trc_fraction, 0.0, 1.0)
        rc_inverse = 1.0 / (eps_inf_edge + chi0)
        trc_inverse = 1.0 / (eps_inf_edge + 0.5 * chi0)
        previous = (
            1.0 - dispersive_fraction
            + rc_fraction * rc_inverse
            + trc_fraction * trc_inverse * (eps_inf_edge - 0.5 * chi0)
        )
        curl = (
            (1.0 - dispersive_fraction) * default_curl
            + (rc_fraction * rc_inverse + trc_fraction * trc_inverse)
            * dt
            / EPSILON_0
        )
        current = -(rc_fraction * rc_inverse + trc_fraction * trc_inverse)
        recurrence_weight = torch.where(
            dispersive_fraction > 0,
            1.0 / dispersive_fraction,
            torch.zeros_like(dispersive_fraction),
        )
        current_decay = torch.where(
            dispersive_fraction > 0,
            decay,
            torch.zeros_like(decay),
        )
        current_new = -(
            rc_fraction + 0.5 * trc_fraction
        ) * recurrence_weight * dchi0
        current_old = -0.5 * trc_fraction * recurrence_weight * dchi0
        components.append(
            (previous, curl, current, current_decay, current_new, current_old)
        )

    stacked = [torch.stack([component[index] for component in components]) for index in range(6)]
    return ElectricUpdateCoefficients(*stacked)


def _expected_unit(descriptor: dict[str, Any], property_name: str) -> str:
    for role in descriptor.get("materials", []):
        property_descriptor = role.get("properties", {}).get(property_name)
        if property_descriptor is not None:
            return property_descriptor["data"]["unit"]
    return "Hz" if property_name.endswith("frequency") else "{ratio}"


def _descriptor_value(
    material: dict[str, Any],
    descriptor: dict[str, Any],
    material_name: str,
    property_name: str,
) -> np.ndarray[Any, np.dtype[np.float64]]:
    value_descriptor = material[property_name]["value"]
    source_unit = value_descriptor["unit"]
    target_unit = _expected_unit(descriptor, property_name)
    offset = convert_ucum_value(0.0, source_unit, target_unit, property_name)
    scale = convert_ucum_value(1.0, source_unit, target_unit, property_name) - offset
    values = np.asarray(value_descriptor["value"], dtype=np.float64) * scale + offset
    if np.any(~np.isfinite(values)):
        raise ValueError(f"Material {material_name!r}.{property_name} must be finite")
    return values


def _isotropic_value(
    material: dict[str, Any],
    descriptor: dict[str, Any],
    material_name: str,
    property_name: str,
) -> float:
    values = _descriptor_value(material, descriptor, material_name, property_name)
    if values.size != 9:
        raise ValueError(f"Material {material_name!r}.{property_name} must be a 3x3 tensor")
    tensor = values.reshape((3, 3))
    scalar = float(np.trace(tensor) / 3.0)
    if not np.allclose(tensor, np.eye(3) * scalar, rtol=1e-6, atol=1e-9):
        raise ValueError(f"Material {material_name!r}.{property_name} must be isotropic")
    if scalar <= 0:
        raise ValueError(f"Material {material_name!r}.{property_name} must be positive")
    return scalar


def _scalar_value(
    material: dict[str, Any],
    descriptor: dict[str, Any],
    material_name: str,
    property_name: str,
) -> float:
    values = _descriptor_value(material, descriptor, material_name, property_name)
    if values.size != 1:
        raise ValueError(f"Material {material_name!r}.{property_name} must be scalar")
    return float(values.reshape(-1)[0])


__all__ = [
    "DRUDE_COLLISION_FREQUENCY",
    "DRUDE_EPSILON_INFINITY",
    "DRUDE_PLASMA_FREQUENCY",
    "MODEL_CODES",
    "MaterialProperties",
    "RELATIVE_PERMITTIVITY",
    "build_update_coefficients",
    "material_properties",
]
