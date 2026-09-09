from __future__ import annotations

import math
from dataclasses import dataclass

import torch


from app.kernel.api import SolverInvocation
from app.kernel.api.world import task_scene
from .setup import (
    PreparedDomain, _raw, _target_part, _positive_float,
    _nonnegative_float, axis_aligned_box_bounds, detector_indices,
)
from typing import Any
import numpy as np


@dataclass(frozen=True, slots=True)
class SoftElectricSource:
    mask: torch.Tensor
    waveform: str
    amplitude: torch.Tensor
    frequency: float
    bandwidth: float
    start_time: float
    end_time: float

    def __post_init__(self) -> None:
        if self.waveform not in {"gaussian", "cw"}:
            raise ValueError(f"unsupported source waveform {self.waveform!r}")
        if self.mask.dtype != torch.bool or self.mask.ndim != 3 or not torch.any(self.mask):
            raise ValueError("source geometry must select at least one FDTD core cell")
        if self.amplitude.shape != (3,) or not torch.all(torch.isfinite(self.amplitude)):
            raise ValueError("source amplitude must contain finite [Ex, Ey, Ez] values")
        if not math.isfinite(self.frequency) or self.frequency <= 0:
            raise ValueError("source frequency must be positive and finite")
        if not math.isfinite(self.bandwidth) or self.bandwidth < 0:
            raise ValueError("source bandwidth must be non-negative and finite")
        if (
            not math.isfinite(self.start_time)
            or not math.isfinite(self.end_time)
            or self.start_time < 0
            or self.end_time <= self.start_time
        ):
            raise ValueError("source time range must satisfy 0 <= startTime < endTime")

    def value(self, time: float) -> torch.Tensor:
        if self.bandwidth == 0:
            envelope = float(self.start_time < time < self.end_time)
        else:
            width = 1.0 / self.bandwidth
            if self.waveform == "gaussian":
                envelope = math.exp(
                    -0.5 * ((time - self.start_time - 5.0 * width) / width) ** 2
                )
            elif time < self.start_time + 5.0 * width:
                envelope = math.exp(
                    -0.5 * ((time - self.start_time - 5.0 * width) / width) ** 2
                )
            elif time <= self.end_time:
                envelope = 1.0
            else:
                envelope = math.exp(-0.5 * ((time - self.end_time) / width) ** 2)
        carrier = math.sin(2.0 * math.pi * self.frequency * time)
        return self.amplitude * (envelope * carrier)

    def apply(self, electric: torch.Tensor, time: float) -> None:
        electric[:, self.mask] += self.value(time).reshape((3, 1))


def validate_source_timing(
    source: SoftElectricSource,
    *,
    simulation_time: float,
    dt: float,
) -> None:
    if source.end_time > simulation_time:
        raise ValueError("source endTime must not exceed simulationTime")
    nyquist = 0.5 / dt
    if source.frequency > nyquist:
        raise ValueError(
            f"source frequency {source.frequency:g} Hz exceeds the {nyquist:g} Hz Nyquist limit"
        )
    if source.frequency + 0.5 * source.bandwidth > nyquist:
        raise ValueError(
            "source frequency plus half its bandwidth exceeds the timestep Nyquist limit"
        )


__all__ = ["SoftElectricSource", "validate_source_timing"]


@dataclass(frozen=True, slots=True)
class SourcePlan:
    mask: np.ndarray[Any, np.dtype[np.bool_]]
    waveform: str
    amplitude: np.ndarray[Any, np.dtype[np.float32]]
    frequency: float
    bandwidth: float
    start_time: float
    end_time: float
    axis: int | None = None
    direction: int = 1


async def prepare_sources(
    invocation: SolverInvocation,
    prepared: PreparedDomain,
) -> list[SourcePlan]:
    scene = task_scene(invocation.world)
    plans: list[SourcePlan] = []
    for index, rule in enumerate(invocation.config["boundaryConditions"]):
        if rule["methodId"] not in {"fdtd.soft-electric-source", "fdtd.tfsf-plane-wave"}:
            continue
        part = _target_part(scene, rule, f"source {index}")
        bounds = await axis_aligned_box_bounds(invocation, scene, part, f"source {index}")
        x, y, z = detector_indices(
            bounds,
            prepared.domain.core_bounds,
            prepared.domain.cell_ticks,
            (1, 1, 1),
            f"source {index}",
        )
        mask = np.zeros(tuple(reversed(prepared.domain.topology.global_shape)), dtype=np.bool_)
        mask[np.ix_(z, y, x)] = True
        parameters = rule["parameters"]
        amplitude = np.asarray(_raw(parameters["amplitude"]), dtype=np.float32)
        if amplitude.shape != (3,) or np.any(~np.isfinite(amplitude)):
            raise ValueError("source amplitude must be finite [Ex, Ey, Ez]")
        is_tfsf = rule["methodId"] == "fdtd.tfsf-plane-wave"
        if is_tfsf:
            if any(prepared.domain.topology.periodic):
                raise ValueError("TFSF requires nonperiodic boundaries")
            # A one-cell exterior/interior collar must remain vacuum and outside CPML.
            collar = np.zeros_like(mask)
            for dimension in range(3):
                collar |= mask != np.roll(mask, 1, axis=dimension)
                collar |= mask != np.roll(mask, -1, axis=dimension)
            for axis_index, indices in enumerate((x, y, z)):
                lower, upper = prepared.pml_cells[axis_index]
                count = mask.shape[2 - axis_index]
                if indices[0] <= lower + 1 or indices[-1] >= count - upper - 2:
                    raise ValueError("TFSF faces require a vacuum collar outside CPML")
                widths = prepared.widths[axis_index][indices[0]-1:indices[-1]+2]
                if not np.allclose(widths, widths[0], rtol=1e-5, atol=0):
                    raise ValueError("TFSF box and its collar require uniform grid spacing")
            if np.any(prepared.epsilon_instantaneous[collar] != 1) or np.any(np.isfinite(prepared.plasma_frequency[collar])):
                raise ValueError("TFSF boundary must lie in vacuum, outside all materials")
        plans.append(
            SourcePlan(
                mask,
                str(_raw(parameters["waveform"])),
                amplitude,
                _positive_float(parameters["frequency"], "frequency"),
                _nonnegative_float(parameters["bandwidth"], "bandwidth"),
                _nonnegative_float(parameters["startTime"], "startTime"),
                _positive_float(parameters["endTime"], "endTime"),
                "xyz".index(str(_raw(parameters["axis"]))) if is_tfsf else None,
                int(_raw(parameters["direction"])) if is_tfsf else 1,
            )
        )
    return plans


