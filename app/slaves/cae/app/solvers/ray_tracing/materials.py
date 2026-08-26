from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from app.solver_framework.units import convert_ucum_value

from .physics import VACUUM_LIGHT_SPEED


@dataclass(frozen=True, slots=True)
class OpticalMaterial:
    name: str
    refractive_index: complex
    absorption_coefficient: float
    scattering_coefficient: float


def optical_material(
    world: dict[str, Any],
    descriptor: dict[str, Any],
    name: str | None,
    wavelength: float,
) -> OpticalMaterial:
    if name is None:
        return OpticalMaterial("vacuum", 1 + 0j, 0.0, 0.0)
    refractive = _property(world, descriptor, name, "optical.refractive_index", wavelength, None)
    extinction = _property(world, descriptor, name, "optical.extinction_coefficient", wavelength, 0.0)
    absorption = _property(world, descriptor, name, "optical.absorption_coefficient", wavelength, None)
    scattering = _property(world, descriptor, name, "optical.scattering_coefficient", wavelength, 0.0)
    if absorption is None:
        absorption = 4 * math.pi * extinction / wavelength
    return OpticalMaterial(name, complex(refractive, -extinction), absorption, scattering)


def _property(
    world: dict[str, Any],
    descriptor: dict[str, Any],
    material_name: str,
    property_name: str,
    wavelength: float,
    default: float | None,
) -> float | None:
    entry = world["materials"]["experiment"]["parameters"]["materials"][material_name].get(property_name)
    if entry is None:
        return default
    value = entry["value"]
    expected = next(
        role["properties"][property_name]["data"]
        for role in descriptor["materials"]
        if property_name in role["properties"]
    )
    source_unit = value["unit"]
    target_unit = expected["unit"]
    path = f"material {material_name!r}.{property_name}"
    offset = convert_ucum_value(0, source_unit, target_unit, path)
    scale = convert_ucum_value(1, source_unit, target_unit, path) - offset
    raw = value["value"]
    axes = value.get("axes")
    if axes is None:
        return float(raw) * scale + offset
    axis = axes[0]
    ticks = np.asarray(axis["ticks"], dtype=np.float64)
    samples = np.asarray(raw, dtype=np.float64)
    frequency = VACUUM_LIGHT_SPEED / wavelength
    return float(np.interp(frequency, ticks, samples)) * scale + offset
