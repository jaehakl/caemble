from __future__ import annotations

from dataclasses import dataclass, field

import torch


EPSILON_0 = 8.854187817620389850e-12


@dataclass(slots=True)
class CpmlState:
    """Convolutional PML coefficients with memory allocated only in PML slabs."""

    shape: tuple[int, int, int]
    pml_cells: tuple[tuple[int, int], tuple[int, int], tuple[int, int]]
    dt: float
    center_wavelength: float
    device: torch.device
    dtype: torch.dtype = torch.float32
    _coefficients: dict[tuple[str, int, str], torch.Tensor] = field(
        default_factory=dict,
        init=False,
    )
    _memory: dict[tuple[str, int, int, str], torch.Tensor] = field(
        default_factory=dict,
        init=False,
    )

    def __post_init__(self) -> None:
        if self.center_wavelength <= 0:
            raise ValueError("CPML center wavelength must be positive")
        for axis, size in enumerate(reversed(self.shape)):
            lower, upper = self.pml_cells[axis]
            if lower < 0 or upper < 0 or lower + upper > size:
                raise ValueError("CPML slab sizes must fit their axes")
            for kind in ("electric", "magnetic"):
                kappa = torch.ones(size, dtype=self.dtype, device=self.device)
                a = torch.zeros_like(kappa)
                b = torch.ones_like(kappa)
                lower_offset = 0.5 if kind == "electric" else 1.0
                upper_offset = 0.5 if kind == "electric" else 0.0
                self._fill_side(kappa, a, b, lower, True, lower_offset)
                self._fill_side(kappa, a, b, upper, False, upper_offset)
                self._coefficients[(kind, axis, "kappa")] = kappa
                self._coefficients[(kind, axis, "a")] = a
                self._coefficients[(kind, axis, "b")] = b

    @property
    def allocated_memory_elements(self) -> int:
        return sum(value.numel() for value in self._memory.values())

    def correct(
        self,
        kind: str,
        field_component: int,
        derivative_axis: int,
        derivative: torch.Tensor,
    ) -> torch.Tensor:
        if kind not in {"electric", "magnetic"}:
            raise ValueError(f"unsupported CPML field kind {kind!r}")
        if field_component == derivative_axis:
            raise ValueError("a curl derivative cannot use its field component axis")
        tensor_axis = 2 - derivative_axis
        lower, upper = self.pml_cells[derivative_axis]
        if lower == 0 and upper == 0:
            return derivative
        result = derivative
        for side, count in (("lower", lower), ("upper", upper)):
            if count == 0:
                continue
            slab = [slice(None)] * derivative.ndim
            slab[tensor_axis] = slice(0, count) if side == "lower" else slice(-count, None)
            slab_index = tuple(slab)
            coefficient_slice = slice(0, count) if side == "lower" else slice(-count, None)
            reshape = [1] * derivative.ndim
            reshape[tensor_axis] = count
            kappa = self._coefficients[(kind, derivative_axis, "kappa")][
                coefficient_slice
            ].reshape(reshape)
            a = self._coefficients[(kind, derivative_axis, "a")][
                coefficient_slice
            ].reshape(reshape)
            b = self._coefficients[(kind, derivative_axis, "b")][
                coefficient_slice
            ].reshape(reshape)
            key = (kind, field_component, derivative_axis, side)
            memory = self._memory.get(key)
            if memory is None:
                memory = torch.zeros_like(derivative[slab_index])
                self._memory[key] = memory
            memory.mul_(b).add_(a * derivative[slab_index])
            result[slab_index] = derivative[slab_index] / kappa + memory
        return result

    def _fill_side(
        self,
        kappa: torch.Tensor,
        a: torch.Tensor,
        b: torch.Tensor,
        count: int,
        lower: bool,
        offset: float,
    ) -> None:
        if count == 0:
            return
        indices = torch.arange(count, dtype=self.dtype, device=self.device)
        depth = (count - indices - offset).clamp(min=0.0) / count
        if not lower:
            depth = torch.flip(depth, dims=(0,))
        alpha = (0.02 / self.center_wavelength) * (1.0 - depth**4)
        local_kappa = 1.0 + 10.0 * depth**4
        sigma = (0.56 / self.center_wavelength) * depth**4
        local_b = torch.exp(-(sigma / local_kappa + alpha) * self.dt / EPSILON_0)
        denominator = sigma * local_kappa + local_kappa.square() * alpha
        local_a = torch.where(
            denominator != 0,
            (local_b - 1.0) * sigma / denominator,
            torch.zeros_like(denominator),
        )
        target = slice(0, count) if lower else slice(-count, None)
        kappa[target] = local_kappa
        a[target] = local_a
        b[target] = local_b


__all__ = ["CpmlState"]
