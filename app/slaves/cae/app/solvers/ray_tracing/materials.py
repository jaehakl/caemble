from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from app.errors import CaeError
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
    if not math.isfinite(wavelength) or wavelength <= 0:
        raise CaeError("invalid_task", "ray wavelength must be positive and finite")
    refractive = _property(world, descriptor, name, "optical.refractive_index", wavelength, None)
    if refractive is None or refractive <= 0:
        raise CaeError("invalid_material", f"material {name!r} requires a positive refractive index")
    extinction = _property(world, descriptor, name, "optical.extinction_coefficient", wavelength, 0.0)
    absorption = _property(world, descriptor, name, "optical.absorption_coefficient", wavelength, None)
    scattering = _property(world, descriptor, name, "optical.scattering_coefficient", wavelength, 0.0)
    if extinction is None or extinction < 0 or scattering is None or scattering < 0:
        raise CaeError("invalid_material", f"material {name!r} optical coefficients must be non-negative")
    if absorption is None:
        absorption = 4 * math.pi * extinction / wavelength
    if absorption < 0:
        raise CaeError("invalid_material", f"material {name!r} absorption coefficient must be non-negative")
    return OpticalMaterial(name, complex(refractive, -extinction), absorption, scattering)


def _property(
    world: dict[str, Any],
    descriptor: dict[str, Any],
    material_name: str,
    property_name: str,
    wavelength: float,
    default: float | None,
) -> float | None:
    materials_by_target = world.get("materials")
    experiment = materials_by_target.get("experiment") if isinstance(materials_by_target, dict) else None
    snapshot = experiment.get("parameters") if isinstance(experiment, dict) else None
    materials = snapshot.get("materials") if isinstance(snapshot, dict) else None
    entry = materials.get(material_name, {}).get(property_name) if isinstance(materials, dict) else None
    if entry is None:
        return default
    value = entry.get("value") if isinstance(entry, dict) else None
    if not isinstance(value, dict) or set(value) not in (
        {"dtype", "value", "unit"},
        {"dtype", "value", "unit", "axes"},
    ):
        raise CaeError(
            "invalid_material",
            f"material {material_name!r}.{property_name} must come from the validated material snapshot",
        )
    expected = None
    for role in descriptor.get("materials", []):
        properties = role.get("properties") if isinstance(role, dict) else None
        candidate = properties.get(property_name) if isinstance(properties, dict) else None
        if isinstance(candidate, dict) and isinstance(candidate.get("data"), dict):
            expected = candidate["data"]
            break
    if expected is None:
        raise CaeError("descriptor_mismatch", f"{property_name} is not declared by the solver descriptor")
    if value.get("dtype") != expected.get("dtype"):
        raise CaeError(
            "invalid_material",
            f"material {material_name!r}.{property_name}.dtype does not match the solver descriptor",
        )
    source_unit = value.get("unit")
    target_unit = expected.get("unit")
    path = f"material {material_name!r}.{property_name}"
    try:
        offset = convert_ucum_value(0, source_unit, target_unit, path)
        scale = convert_ucum_value(1, source_unit, target_unit, path) - offset
    except CaeError as exc:
        raise CaeError("invalid_material", str(exc)) from exc
    raw = value.get("value")
    axes = value.get("axes")
    if axes is None:
        if not isinstance(raw, (int, float)) or isinstance(raw, bool) or not math.isfinite(raw):
            raise CaeError("invalid_material", f"{path}.value must be a finite scalar")
        return float(raw) * scale + offset
    axis = axes[0] if isinstance(axes, list) and len(axes) == 1 else None
    if (
        not isinstance(axis, dict)
        or axis.get("name") != "frequency"
        or axis.get("unit") != "Hz"
        or axis.get("quantityKind") != "Frequency"
        or not isinstance(axis.get("ticks"), list)
        or not isinstance(raw, list)
        or len(raw) != len(axis["ticks"])
    ):
        raise CaeError("invalid_material", f"{path} must use one canonical Frequency axis")
    ticks = np.asarray(axis["ticks"], dtype=np.float64)
    samples = np.asarray(raw, dtype=np.float64)
    if (
        ticks.ndim != 1
        or len(ticks) < 2
        or np.any(~np.isfinite(ticks))
        or np.any(np.diff(ticks) <= 0)
        or np.any(~np.isfinite(samples))
    ):
        raise CaeError("invalid_material", f"{path} frequency series is invalid")
    frequency = VACUUM_LIGHT_SPEED / wavelength
    if frequency < ticks[0] or frequency > ticks[-1]:
        raise CaeError(
            "invalid_material",
            f"{path} has no sample range covering {frequency:.9g} Hz",
        )
    return float(np.interp(frequency, ticks, samples)) * scale + offset
