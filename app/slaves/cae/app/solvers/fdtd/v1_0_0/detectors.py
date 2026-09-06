from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import torch

from app.runtime_kernel.api import BundleValue


@dataclass(frozen=True, slots=True)
class DetectorRegion:
    z: np.ndarray[Any, np.dtype[np.int64]]
    y: np.ndarray[Any, np.dtype[np.int64]]
    x: np.ndarray[Any, np.dtype[np.int64]]
    ticks: tuple[np.ndarray[Any, np.dtype[np.float64]], ...]

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

    def artifact(self) -> BundleValue:
        values = np.stack(self.samples).astype(np.float32, copy=False)
        return BundleValue(
            self.artifact_type,
            {
                "field": _field_member(
                    values,
                    np.asarray(self.times, dtype=np.float64),
                    self.region.ticks,
                    self.field_kind,
                    "time",
                    "s",
                )
            },
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

    def artifact(self) -> BundleValue:
        if self.sample_count == 0:
            raise ValueError("spectral detector received no samples")
        values = (self.accumulator / self.sample_count).detach().cpu()
        axes = (self.frequencies, *self.region.ticks)
        return BundleValue(
            self.artifact_type,
            {
                "real": _field_member(
                    values.real.to(torch.float32).numpy(),
                    axes[0],
                    axes[1:],
                    self.field_kind,
                    "frequency",
                    "Hz",
                ),
                "imag": _field_member(
                    values.imag.to(torch.float32).numpy(),
                    axes[0],
                    axes[1:],
                    self.field_kind,
                    "frequency",
                    "Hz",
                ),
            },
        )


def requested_frequencies(start: float, stop: float, step: float, dt: float) -> np.ndarray:
    if not all(math.isfinite(value) for value in (start, stop, step)):
        raise ValueError("spectral frequency range must be finite")
    if start < 0 or stop < start or step <= 0:
        raise ValueError("frequency range must satisfy 0 <= start <= stop and step > 0")
    nyquist = 0.5 / dt
    if stop > nyquist:
        raise ValueError(f"frequencyStop {stop:g} Hz exceeds the {nyquist:g} Hz Nyquist limit")
    count = math.floor(math.nextafter((stop - start) / step, math.inf)) + 1
    return start + np.arange(count, dtype=np.float64) * step


def _field_member(
    values: np.ndarray[Any, np.dtype[np.float32]],
    first_ticks: np.ndarray[Any, np.dtype[np.float64]],
    spatial_ticks: tuple[np.ndarray[Any, np.dtype[np.float64]], ...],
    field_kind: str,
    first_axis: str,
    first_unit: str,
) -> dict[str, Any]:
    quantity_kind = (
        "electromagnetism.ElectricFieldStrength"
        if field_kind == "electric"
        else "electromagnetism.MagneticFieldStrength"
    )
    unit = "V.m-1" if field_kind == "electric" else "A.m-1"
    return {
        "value": values,
        "axes": [
            {"name": first_axis, "unit": first_unit, "ticks": first_ticks},
            {"name": "z", "unit": "m", "ticks": spatial_ticks[0]},
            {"name": "y", "unit": "m", "ticks": spatial_ticks[1]},
            {"name": "x", "unit": "m", "ticks": spatial_ticks[2]},
        ],
        "basis": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        "components": [
            "Ex" if field_kind == "electric" else "Hx",
            "Ey" if field_kind == "electric" else "Hy",
            "Ez" if field_kind == "electric" else "Hz",
        ],
        "quantityKind": quantity_kind,
        "unit": unit,
    }


__all__ = [
    "DetectorRegion",
    "SpectralDetector",
    "TimeDetector",
    "requested_frequencies",
]
