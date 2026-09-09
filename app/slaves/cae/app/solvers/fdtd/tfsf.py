"""Axis-aligned vacuum TFSF using a matched auxiliary Yee line.

Stored fields are scattered outside the box and total inside it. The discrete
commutator M D(Finc) - D(M Finc) corrects only differences crossing its faces.
This also covers edges/corners without independently double-counting faces.
"""
from __future__ import annotations

import math
import numpy as np
import torch

from .physics import EPSILON_0, MU_0, FDTDEngine


class TfsfSource:
    def __init__(self, engine: FDTDEngine, mask: np.ndarray, axis: int,
                 direction: int, amplitude: np.ndarray, frequency: float,
                 bandwidth: float, start_time: float, end_time: float,
                 step_count: int):
        if axis not in (0, 1, 2) or direction not in (-1, 1):
            raise ValueError("TFSF requires an axis x/y/z and direction -1/+1")
        if amplitude[axis] != 0 or not np.any(amplitude):
            raise ValueError("TFSF electric amplitude must be nonzero and transverse")
        self.axis = axis
        self.direction = direction
        self.dt = engine.dt
        self.frequency = frequency
        self.bandwidth = bandwidth
        self.start_time = start_time
        self.end_time = end_time
        self.device = engine.electric.device
        # Causal padding prevents either end reflecting back during this run.
        self.padding = step_count + 8
        occupied = np.nonzero(mask)[2-axis]
        self.line_start = int(occupied.min()) - 1
        self.count = int(occupied.max()) - self.line_start + 2
        # Only the box/collar needs the incident solution. Extending the actual
        # coarse buffer into this line would reflect light back into the box.
        # Use the same *uniform* Yee spacing as the TFSF region throughout it.
        self.spacing = float(engine.widths[axis][int(occupied.min())])
        self.electric = torch.zeros(self.count + 2*self.padding, dtype=torch.float32, device=self.device)
        self.magnetic = torch.zeros_like(self.electric)
        self.source_index = self.padding - 3 if direction == 1 else self.padding + self.count + 2
        self.e_amplitude = amplitude
        # The auxiliary H is positive for +axis propagation; its sign emerges
        # from the source location, so do not multiply by direction here.
        normal = np.eye(3)[axis]
        self.h_amplitude = np.cross(normal, amplitude)
        self.boundaries = {}
        for forward in (True, False):
            for derivative_axis in range(3):
                dimension = 2 - derivative_axis
                adjacent = np.roll(mask, -1 if forward else 1, axis=dimension)
                delta = mask.astype(np.int8) - adjacent.astype(np.int8)
                edge = [slice(None)] * 3
                edge[dimension] = -1 if forward else 0
                delta[tuple(edge)] = 0
                indices = np.nonzero(delta)
                neighbor = indices[dimension] + (1 if forward else -1)
                widths = engine.widths[derivative_axis].detach().cpu().numpy()
                weight = delta[indices] / (0.5 * (widths[indices[dimension]] + widths[neighbor]))
                if not forward:
                    weight = -weight
                line_indices = indices[2 - axis].copy() + self.padding - self.line_start
                if derivative_axis == axis:
                    line_indices += 1 if forward else -1
                self.boundaries[forward, derivative_axis] = (
                    tuple(torch.as_tensor(v, device=self.device) for v in indices),
                    torch.as_tensor(line_indices, device=self.device),
                    torch.as_tensor(weight, dtype=torch.float32, device=self.device),
                )

    def inject(self, time: float) -> None:
        if time < self.start_time or time > self.end_time:
            return
        width = 1.0 / self.bandwidth
        envelope = math.exp(-0.5 * ((time - self.start_time - 5 * width) / width) ** 2)
        self.electric[self.source_index] += envelope * math.sin(2 * math.pi * self.frequency * time)

    def step_magnetic(self) -> None:
        self.magnetic[:-1] -= self.dt / MU_0 * (self.electric[1:] - self.electric[:-1]) / self.spacing

    def step_electric(self) -> None:
        self.electric[1:] -= self.dt / EPSILON_0 * (self.magnetic[1:] - self.magnetic[:-1]) / self.spacing

    def correct(self, kind: str, component: int, axis: int, derivative: torch.Tensor) -> None:
        forward = kind == "magnetic"
        amplitude = self.e_amplitude[component] if forward else self.h_amplitude[component]
        if amplitude == 0:
            return
        indices, line_indices, weight = self.boundaries[forward, axis]
        field = self.electric if forward else self.magnetic
        derivative[indices] += float(amplitude) * weight * field[line_indices]
