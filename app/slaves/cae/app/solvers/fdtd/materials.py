from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np
import torch

from app.kernel.api.world import material_model

from .physics import EPSILON_0, ElectricUpdateCoefficients, transverse_edge_average


DRUDE_METHOD_CODES = {"none": 0, "RC": 1, "TRC": 2}


@dataclass(frozen=True, slots=True)
class MaterialProperties:
    epsilon_instantaneous: float
    plasma_frequency: float | None
    damping_frequency: float | None

    @property
    def has_drude(self) -> bool:
        return self.plasma_frequency is not None


def material_properties(
    world: dict[str, Any], part: dict[str, Any], *, source: str, role: str,
) -> MaterialProperties:
    name = part["material"]["name"]
    model = material_model(world, part, role, "electricResponse", source)
    if model is None:
        raise ValueError(f"Material {name!r} requires an electric-response model")
    parameters = model["parameters"]
    if model["model"] == "em.nondispersive-isotropic@1":
        epsilon = _isotropic_value(parameters["epsilon"]["value"], name)
        return MaterialProperties(epsilon, None, None)
    if model["model"] == "em.drude-isotropic@1":
        epsilon = _isotropic_value(parameters["epsilonInfinity"]["value"], name)
        plasma = float(parameters["plasmaFrequency"]["value"])
        damping = float(parameters["dampingFrequency"]["value"])
        if not math.isfinite(plasma) or plasma < 0:
            raise ValueError(f"Material {name!r} plasmaFrequency must be nonnegative and finite")
        if not math.isfinite(damping) or damping <= 0:
            raise ValueError(f"Material {name!r} dampingFrequency must be positive and finite for FDTD RC/TRC")
        return MaterialProperties(epsilon, plasma, damping)
    raise ValueError(f"FDTD does not implement Material model {model['model']!r}")


def build_update_coefficients(
    epsilon_instantaneous: np.ndarray[Any, np.dtype[np.float32]],
    plasma_frequency: np.ndarray[Any, np.dtype[np.float32]],
    damping_frequency: np.ndarray[Any, np.dtype[np.float32]],
    model_codes: np.ndarray[Any, np.dtype[np.uint8]],
    dt: float,
    periodic: Sequence[bool],
    device: torch.device,
) -> ElectricUpdateCoefficients:
    arrays = (
        epsilon_instantaneous,
        plasma_frequency,
        damping_frequency,
        model_codes,
    )
    if any(array.shape != epsilon_instantaneous.shape for array in arrays):
        raise ValueError("all FDTD material arrays must have the same shape")
    eps = torch.as_tensor(epsilon_instantaneous, dtype=torch.float32, device=device)
    if torch.any(~torch.isfinite(eps)) or torch.any(eps <= 0):
        raise ValueError("relative permittivity must be positive and finite in every cell")
    has_drude = bool(
        np.any(
            (model_codes != 0)
            & np.isfinite(plasma_frequency)
            & (plasma_frequency > 0)
            & np.isfinite(damping_frequency)
        )
    )
    if not has_drude:
        if np.all(epsilon_instantaneous == epsilon_instantaneous.flat[0]):
            curl = torch.tensor(
                dt / (EPSILON_0 * float(epsilon_instantaneous.flat[0])),
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

    plasma = torch.as_tensor(plasma_frequency, dtype=torch.float32, device=device)
    collision = torch.as_tensor(damping_frequency, dtype=torch.float32, device=device)
    models = torch.as_tensor(model_codes, dtype=torch.uint8, device=device)

    components: list[tuple[torch.Tensor, ...]] = []
    for component in range(3):
        eps_edge = transverse_edge_average(eps, component, periodic)
        drude_cell = (models != 0) & torch.isfinite(plasma) & (plasma > 0) & torch.isfinite(collision)
        metal_fraction = transverse_edge_average(drude_cell.to(torch.float32), component, periodic)
        weight = metal_fraction.clamp_min(torch.finfo(torch.float32).eps)
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
        omega_p = torch.where(metal_fraction > 0, omega_p, torch.ones_like(omega_p))
        omega_c = torch.where(metal_fraction > 0, omega_c, torch.ones_like(omega_c))
        decay = torch.exp(-omega_c * dt)
        chi0 = omega_p.square() * dt / omega_c - (
            omega_p / omega_c
        ).square() * (1.0 - decay)
        dchi0 = -((omega_p / omega_c) * (1.0 - decay)).square()

        rc_fraction = transverse_edge_average(
            ((models == 1) & drude_cell).to(torch.float32), component, periodic
        )
        trc_fraction = transverse_edge_average(
            ((models == 2) & drude_cell).to(torch.float32), component, periodic
        )
        denominator = eps_edge + (rc_fraction + 0.5 * trc_fraction) * chi0
        previous = (eps_edge - 0.5 * trc_fraction * chi0) / denominator
        curl = dt / (EPSILON_0 * denominator)
        current = torch.where(metal_fraction > 0, -1.0 / denominator, torch.zeros_like(denominator))
        current_decay = torch.where(metal_fraction > 0, decay, torch.zeros_like(decay))
        current_new = -(rc_fraction + 0.5 * trc_fraction) * dchi0
        current_old = -0.5 * trc_fraction * dchi0
        components.append(
            (previous, curl, current, current_decay, current_new, current_old)
        )

    stacked = [torch.stack([component[index] for component in components]) for index in range(6)]
    return ElectricUpdateCoefficients(*stacked)


def _isotropic_value(value: Any, material_name: str) -> float:
    tensor = np.asarray(value, dtype=np.float64).reshape((3, 3))
    scalar = float(np.trace(tensor) / 3.0)
    if not np.all(np.isfinite(tensor)) or not np.allclose(tensor, np.eye(3) * scalar, rtol=1e-6, atol=1e-9):
        raise ValueError(f"Material {material_name!r} permittivity must be a finite isotropic tensor")
    if scalar <= 0:
        raise ValueError(f"Material {material_name!r} permittivity must be positive")
    return scalar
