from __future__ import annotations

import math
from dataclasses import dataclass

import torch


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
