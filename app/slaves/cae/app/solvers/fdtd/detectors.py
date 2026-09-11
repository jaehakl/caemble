from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import torch

from app.kernel.api import FieldValue, StructuredGridValue, SolverInvocation
from app.kernel.api.world import task_scene
from .setup import (
    PreparedDomain,
    _target_part,
    _positive_int,
    axis_aligned_box_bounds,
    detector_indices,
)


@dataclass(frozen=True, slots=True)
class DetectorRegion:
    z: np.ndarray[Any, np.dtype[np.int64]]
    y: np.ndarray[Any, np.dtype[np.int64]]
    x: np.ndarray[Any, np.dtype[np.int64]]
    ticks: tuple[np.ndarray[Any, np.dtype[np.float64]], ...]
    bounds: tuple[tuple[float, float], ...] | None = None

    def __post_init__(self) -> None:
        if self.z.size == 0 or self.y.size == 0 or self.x.size == 0:
            raise ValueError("detector geometry must select at least one cell on every axis")

    def sample(self, values: torch.Tensor) -> torch.Tensor:
        z = torch.as_tensor(self.z, dtype=torch.long, device=values.device)
        y = torch.as_tensor(self.y, dtype=torch.long, device=values.device)
        x = torch.as_tensor(self.x, dtype=torch.long, device=values.device)
        return values[:, z[:, None, None], y[None, :, None], x[None, None, :]].permute(
            1, 2, 3, 0
        )


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

    def artifact(self) -> FieldValue:
        values = np.stack(self.samples).astype(np.float32, copy=False)
        return _field_member(
            values, np.asarray(self.times, dtype=np.float64), self.region.ticks,
            self.field_kind, "time", "s", self.region.bounds,
        )


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
            self.region.z.size,
            self.region.y.size,
            self.region.x.size,
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

    def artifact(self) -> FieldValue:
        if self.sample_count == 0:
            raise ValueError("spectral detector received no samples")
        values = (self.accumulator / self.sample_count).detach().cpu().numpy()
        return _field_member(
            values, self.frequencies, self.region.ticks,
            self.field_kind, "frequency", "Hz", self.region.bounds,
        )


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


def _field_member(
    values: np.ndarray[Any, np.dtype[np.float32] | np.dtype[np.complex64]],
    first_ticks: np.ndarray[Any, np.dtype[np.float64]],
    spatial_ticks: tuple[np.ndarray[Any, np.dtype[np.float64]], ...],
    field_kind: str,
    first_axis: str,
    first_unit: str,
    bounds: tuple[tuple[float, float], ...] | None = None,
) -> FieldValue:
    quantity_kind = (
        "electromagnetism.ElectricFieldStrength"
        if field_kind == "electric"
        else "electromagnetism.MagneticFieldStrength"
    )
    unit = "V.m-1" if field_kind == "electric" else "A.m-1"
    return FieldValue(
        domain=StructuredGridValue(
            shape=tuple(len(axis) for axis in spatial_ticks),
            axes=spatial_ticks,
            unit="m",
            metadata={"bounds": bounds} if bounds is not None else {},
        ),
        location="cell",
        quantity_kind=quantity_kind,
        unit=unit,
        values=values,
        basis=[[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        components=tuple(("E" if field_kind == "electric" else "H") + axis for axis in "xyz"),
        metadata={"sampleAxes": [{"name": first_axis, "unit": first_unit, "ticks": first_ticks}]},
    )



__all__ = [
    "DetectorRegion",
    "SpectralDetector",
    "TimeDetector",
    "requested_frequencies",
]


_OUTPUT_TYPES = {
    "fdtd.time-electric-field": ("caemble.fdtd/time-electric-field@2", "electric"),
    "fdtd.time-magnetic-field": ("caemble.fdtd/time-magnetic-field@2", "magnetic"),
    "fdtd.spectral-electric-field": (
        "caemble.fdtd/spectral-electric-field@2",
        "electric",
    ),
    "fdtd.spectral-magnetic-field": (
        "caemble.fdtd/spectral-magnetic-field@2",
        "magnetic",
    ),
}


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
    scene = task_scene(invocation.world)
    plans: list[OutputPlan] = []
    for index, rule in enumerate(invocation.config["outputs"]):
        method = rule["methodId"]
        if method not in _OUTPUT_TYPES:
            continue
        part = _target_part(scene, rule, f"detector {index}")
        bounds = await axis_aligned_box_bounds(
            invocation, scene, part, f"detector {index}"
        )
        parameters = rule["parameters"]
        strides = tuple(
            _positive_int(parameters[name], name)
            for name in ("strideX", "strideY", "strideZ")
        )
        x, y, z = detector_indices(
            bounds,
            prepared.domain.core_bounds,
            prepared.domain.cell_ticks,
            strides,
            f"detector {index}",
        )
        domain_ticks = prepared.domain.cell_ticks
        region = DetectorRegion(
            z,
            y,
            x,
            (
                np.asarray(domain_ticks[2], dtype=np.float64)[z],
                np.asarray(domain_ticks[1], dtype=np.float64)[y],
                np.asarray(domain_ticks[0], dtype=np.float64)[x],
            ),
            tuple(bounds[axis] for axis in (2, 1, 0)),
        )
        artifact_type, field_kind = _OUTPUT_TYPES[method]
        if method.startswith("fdtd.time-"):
            plans.append(
                OutputPlan(
                    method,
                    rule["key"],
                    artifact_type,
                    field_kind,
                    region,
                    time_stride=_positive_int(parameters["timeStride"], "timeStride"),
                )
            )
        else:
            plans.append(
                OutputPlan(
                    method,
                    rule["key"],
                    artifact_type,
                    field_kind,
                    region,
                    frequencies=requested_frequencies(
                        parameters["frequencies"]["value"],
                        prepared.dt,
                    ),
                )
            )
    return plans


