from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from app.kernel.api.world import material_model
from app.methods.optics import VACUUM_LIGHT_SPEED


@dataclass(frozen=True, slots=True)
class OpticalMaterial:
    name: str
    refractive_index: complex
    absorption_coefficient: float
    scattering_coefficient: float


def optical_material(
    world: dict[str, Any], name: str | None, wavelength: float,
) -> OpticalMaterial:
    if name is None:
        return OpticalMaterial("vacuum", 1 + 0j, 0.0, 0.0)
    part = {"material": {"name": name}}
    optical = material_model(world, part, "opticalDomain", "opticalResponse")
    if optical is None:
        raise ValueError(f"Material {name!r} requires a complex refractive-index model")
    refractive = _parameter(optical, "n", wavelength)
    extinction = _parameter(optical, "k", wavelength)
    absorption_model = material_model(world, part, "opticalDomain", "absorption")
    scattering_model = material_model(world, part, "opticalDomain", "scattering")
    absorption = (
        4 * math.pi * extinction / wavelength
        if absorption_model is None else _parameter(absorption_model, "alpha", wavelength)
    )
    scattering = 0.0 if scattering_model is None else _parameter(scattering_model, "sigma", wavelength)
    return OpticalMaterial(name, complex(refractive, -extinction), absorption, scattering)


def _parameter(model: dict[str, Any], name: str, wavelength: float) -> float:
    parameters = model["parameters"]
    if model["model"] in {
        "optics.constant-complex-index@1", "optics.constant-absorption@1",
        "optics.constant-scattering@1",
    }:
        return float(parameters[name]["value"])
    if model["model"] in {
        "optics.frequency-sampled-complex-index@1", "optics.frequency-sampled-absorption@1",
        "optics.frequency-sampled-scattering@1",
    }:
        samples = parameters["samples"]
        return float(np.interp(
            VACUUM_LIGHT_SPEED / wavelength,
            [sample["frequency"]["value"] for sample in samples],
            [sample[name]["value"] for sample in samples],
        ))
    raise ValueError(f"Ray tracing does not implement model {model['model']!r}")
