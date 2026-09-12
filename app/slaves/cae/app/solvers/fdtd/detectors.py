from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import product
from typing import Any

import numpy as np
import torch

from app.kernel.api import SolverInvocation
from app.methods.fields.box_grid import BoxGrid, RectilinearSampler, pack_box_grid
from .setup import PreparedDomain, _positive_int


@dataclass(frozen=True, slots=True)
class DetectorRegion:
    sampler: RectilinearSampler
    grid: BoxGrid
    data: dict[str, Any]

    def sample(self, values: torch.Tensor) -> torch.Tensor:
        sampler = self.sampler
        result = torch.zeros((len(sampler.valid), values.shape[0]), dtype=values.dtype, device=values.device)
        for corner in product((0, 1), repeat=3):
            indices = tuple(torch.as_tensor(sampler.indices[axis][side], device=values.device)
                            for axis, side in enumerate(corner))
            weight = np.ones(len(sampler.valid))
            for axis, side in enumerate(corner):
                weight *= sampler.weights[axis] if side else 1 - sampler.weights[axis]
            result += values[(slice(None), *indices)].T * torch.as_tensor(weight[:, None], dtype=values.dtype, device=values.device)
        result[torch.as_tensor(~sampler.valid, device=values.device)] = 0
        return result.reshape((*sampler.shape, values.shape[0]))



@dataclass(slots=True)
class TimeDetector:
    key: str
    artifact_type: str
    field_kind: str
    region: DetectorRegion
    time_stride: int
    samples: list[np.ndarray[Any, np.dtype[np.float32]]] = field(default_factory=list)
    times: list[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.field_kind not in {"electric", "magnetic"}:
            raise ValueError("time detector field kind must be electric or magnetic")
        if self.time_stride <= 0:
            raise ValueError("timeStride must be a positive integer")

    def capture(self, step: int, time: float, values: torch.Tensor, *, final: bool) -> None:
        if step % self.time_stride != 0 and not final:
            return
        self.samples.append(
            self.region.sample(values).detach().to(device="cpu", dtype=torch.float32).numpy()
        )
        self.times.append(time)

    def artifact(self) -> dict[str, Any]:
        values = np.stack(self.samples).astype(np.float32, copy=False)
        return pack_box_grid(self.region.grid, self.region.data, np.moveaxis(values, 0, 3), times=self.times)



@dataclass(slots=True)
class SpectralDetector:
    key: str
    artifact_type: str
    field_kind: str
    region: DetectorRegion
    frequencies: np.ndarray[Any, np.dtype[np.float64]]
    device: torch.device
    accumulator: torch.Tensor = field(init=False)
    sample_count: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        if self.field_kind not in {"electric", "magnetic"}:
            raise ValueError("spectral detector field kind must be electric or magnetic")
        if self.frequencies.ndim != 1 or self.frequencies.size == 0:
            raise ValueError("spectral detector must request at least one frequency")
        if np.any(~np.isfinite(self.frequencies)) or np.any(self.frequencies < 0):
            raise ValueError("spectral frequencies must be finite and non-negative")
        shape = (
            self.frequencies.size,
            *self.region.grid.shape,
            3,
        )
        self.accumulator = torch.zeros(shape, dtype=torch.complex64, device=self.device)

    def capture(self, time: float, values: torch.Tensor) -> None:
        sampled = self.region.sample(values).to(torch.complex64)
        frequencies = torch.as_tensor(
            self.frequencies, dtype=torch.float32, device=self.device
        )
        phase = torch.exp(
            torch.complex(
                torch.zeros_like(frequencies),
                -2.0 * math.pi * frequencies * time,
            )
        )
        self.accumulator.add_(phase.reshape((-1, 1, 1, 1, 1)) * sampled.unsqueeze(0))
        self.sample_count += 1

    def artifact(self) -> dict[str, Any]:
        if self.sample_count == 0:
            raise ValueError("spectral detector received no samples")
        values = (self.accumulator / self.sample_count).detach().cpu().numpy()
        return pack_box_grid(self.region.grid, self.region.data, np.moveaxis(values, 0, 3), frequencies=self.frequencies)



def requested_frequencies(values: Any, dt: float) -> np.ndarray:
    frequencies = np.asarray(values, dtype=np.float64)
    if (
        frequencies.ndim != 1 or frequencies.size == 0
        or np.any(~np.isfinite(frequencies)) or np.any(frequencies < 0)
    ):
        raise ValueError("frequencies must be a nonempty tensor of finite non-negative Hz values")
    nyquist = 0.5 / dt
    if np.any(frequencies > nyquist):
        raise ValueError(f"frequencies exceed the {nyquist:g} Hz Nyquist limit")
    return frequencies



@dataclass(frozen=True, slots=True)
class OutputPlan:
    method: str
    key: str
    artifact_type: str
    field_kind: str
    region: DetectorRegion
    time_stride: int | None = None
    frequencies: np.ndarray[Any, np.dtype[np.float64]] | None = None


async def prepare_detectors(
    invocation: SolverInvocation,
    prepared: PreparedDomain,
) -> list[OutputPlan]:
    plans: list[OutputPlan] = []
    definitions = {item["methodId"]: item for item in invocation.descriptor["methods"]["outputs"]}
    domain_ticks = prepared.domain.cell_ticks
    for rule in invocation.config["outputs"]:
        method = rule["methodId"]
        definition = definitions[method]
        grid = BoxGrid(rule["boxGrid"])
        points = grid.points("m")[..., ::-1]
        sampler = RectilinearSampler.prepare(tuple(reversed(domain_ticks)), points,
                                             tuple(reversed(prepared.domain.core_bounds)))
        region = DetectorRegion(sampler, grid, definition["data"])
        field_kind = "electric" if "electric" in method else "magnetic"
        parameters = rule["parameters"]
        if method.startswith("fdtd.time-"):
            plans.append(OutputPlan(method, rule["key"], definition["artifactType"], field_kind, region,
                                    time_stride=_positive_int(parameters["timeStride"], "timeStride")))
        else:
            plans.append(OutputPlan(method, rule["key"], definition["artifactType"], field_kind, region,
                                    frequencies=requested_frequencies(parameters["frequencies"]["value"], prepared.dt)))
    return plans
