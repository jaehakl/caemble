from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

import torch

from .pml import CpmlState


LIGHT_SPEED = 299_792_458.0
MU_0 = 1.256637061435917295e-6
EPSILON_0 = 8.854187817620389850e-12


def _axis_dimension(axis: int) -> int:
    if axis not in (0, 1, 2):
        raise ValueError("axis must be x=0, y=1, or z=2")
    return 2 - axis


def forward_difference(
    values: torch.Tensor,
    widths: torch.Tensor,
    axis: int,
    periodic: bool,
) -> torch.Tensor:
    dimension = _axis_dimension(axis)
    if widths.ndim != 1 or widths.numel() != values.shape[dimension]:
        raise ValueError("width vector must match the differentiated tensor axis")
    result = torch.zeros_like(values)
    current = [slice(None)] * values.ndim
    following = [slice(None)] * values.ndim
    current[dimension] = slice(0, -1)
    following[dimension] = slice(1, None)
    shape = [1] * values.ndim
    shape[dimension] = widths.numel() - 1
    result[tuple(current)] = (
        values[tuple(following)] - values[tuple(current)]
    ) / (0.5 * (widths[:-1] + widths[1:])).reshape(shape)
    if periodic:
        boundary = [slice(None)] * values.ndim
        opposite = [slice(None)] * values.ndim
        boundary[dimension] = -1
        opposite[dimension] = 0
        result[tuple(boundary)] = (
            values[tuple(opposite)] - values[tuple(boundary)]
        ) / (0.5 * (widths[-1] + widths[0]))
    return result


def backward_difference(
    values: torch.Tensor,
    widths: torch.Tensor,
    axis: int,
    periodic: bool,
) -> torch.Tensor:
    dimension = _axis_dimension(axis)
    if widths.ndim != 1 or widths.numel() != values.shape[dimension]:
        raise ValueError("width vector must match the differentiated tensor axis")
    result = torch.zeros_like(values)
    current = [slice(None)] * values.ndim
    preceding = [slice(None)] * values.ndim
    current[dimension] = slice(1, None)
    preceding[dimension] = slice(0, -1)
    shape = [1] * values.ndim
    shape[dimension] = widths.numel() - 1
    result[tuple(current)] = (
        values[tuple(current)] - values[tuple(preceding)]
    ) / (0.5 * (widths[1:] + widths[:-1])).reshape(shape)
    if periodic:
        boundary = [slice(None)] * values.ndim
        opposite = [slice(None)] * values.ndim
        boundary[dimension] = 0
        opposite[dimension] = -1
        result[tuple(boundary)] = (
            values[tuple(boundary)] - values[tuple(opposite)]
        ) / (0.5 * (widths[0] + widths[-1]))
    return result


def transverse_edge_average(
    values: torch.Tensor,
    component_axis: int,
    periodic: Sequence[bool],
) -> torch.Tensor:
    first_axis, second_axis = (axis for axis in range(3) if axis != component_axis)
    diagonal = _shift_with_edge(
        _shift_with_edge(values, first_axis, 1, periodic[first_axis]),
        second_axis,
        1,
        periodic[second_axis],
    )
    return (
        values
        + _shift_with_edge(values, first_axis, 1, periodic[first_axis])
        + _shift_with_edge(values, second_axis, 1, periodic[second_axis])
        + diagonal
    ) * 0.25


def cell_center_fields(
    electric: torch.Tensor,
    magnetic: torch.Tensor,
    periodic: Sequence[bool],
) -> tuple[torch.Tensor, torch.Tensor]:
    centered_electric = torch.empty_like(electric)
    centered_magnetic = torch.empty_like(magnetic)
    for component in range(3):
        transverse = [axis for axis in range(3) if axis != component]
        first = _shift_with_edge(
            electric[component], transverse[0], -1, periodic[transverse[0]]
        )
        second = _shift_with_edge(
            electric[component], transverse[1], -1, periodic[transverse[1]]
        )
        diagonal = _shift_with_edge(
            first, transverse[1], -1, periodic[transverse[1]]
        )
        centered_electric[component] = (
            electric[component] + first + second + diagonal
        ) * 0.25
        centered_magnetic[component] = 0.5 * (
            magnetic[component]
            + _shift_with_edge(
                magnetic[component], component, -1, periodic[component]
            )
        )
    return centered_electric, centered_magnetic


def _shift_with_edge(
    values: torch.Tensor,
    axis: int,
    shift: int,
    periodic: bool,
) -> torch.Tensor:
    dimension = _axis_dimension(axis)
    shifted = torch.roll(values, shifts=shift, dims=dimension)
    if periodic:
        return shifted
    boundary = [slice(None)] * values.ndim
    source = [slice(None)] * values.ndim
    if shift > 0:
        boundary[dimension] = slice(0, shift)
        source[dimension] = slice(0, 1)
    else:
        boundary[dimension] = slice(shift, None)
        source[dimension] = slice(-1, None)
    shifted[tuple(boundary)] = values[tuple(source)]
    return shifted


@dataclass(slots=True)
class ElectricUpdateCoefficients:
    previous: torch.Tensor | None
    curl: torch.Tensor
    current: torch.Tensor | None
    current_decay: torch.Tensor | None
    current_new: torch.Tensor | None
    current_old: torch.Tensor | None


@dataclass(slots=True)
class FDTDEngine:
    widths: tuple[torch.Tensor, torch.Tensor, torch.Tensor]
    periodic: tuple[bool, bool, bool]
    dt: float
    coefficients: ElectricUpdateCoefficients
    cpml: CpmlState | None = None
    electric: torch.Tensor = field(init=False)
    magnetic: torch.Tensor = field(init=False)
    current: torch.Tensor | None = field(init=False)
    _uniform_widths: tuple[float | None, float | None, float | None] = field(
        init=False,
        repr=False,
    )

    def __post_init__(self) -> None:
        shape = tuple(int(width.numel()) for width in reversed(self.widths))
        device = self.widths[0].device
        self.electric = torch.zeros((3, *shape), dtype=torch.float32, device=device)
        self.magnetic = torch.zeros_like(self.electric)
        self.current = (
            torch.zeros_like(self.electric)
            if self.coefficients.current_decay is not None
            else None
        )
        self._uniform_widths = tuple(
            float(width[0]) if bool(torch.all(width == width[0])) else None
            for width in self.widths
        )

    def step_magnetic(self) -> None:
        scale = self.dt / MU_0
        curls = (((2, 1), (1, 2)), ((0, 2), (2, 0)), ((1, 0), (0, 1)))
        for component, (first, second) in enumerate(curls):
            derivative_a = self._derivative("magnetic", *first, True)
            derivative_b = self._derivative("magnetic", *second, True)
            self.magnetic[component].sub_(scale * (derivative_a - derivative_b))

    def step_electric(self) -> None:
        coefficient = self.coefficients
        if coefficient.previous is None:
            curls = (((2, 1), (1, 2)), ((0, 2), (2, 0)), ((1, 0), (0, 1)))
            for component, (first, second) in enumerate(curls):
                derivative_a = self._derivative("electric", *first, False)
                derivative_b = self._derivative("electric", *second, False)
                curl_coefficient = (
                    coefficient.curl
                    if coefficient.curl.ndim == 0
                    else coefficient.curl[component]
                )
                self.electric[component].add_(
                    curl_coefficient * (derivative_a - derivative_b)
                )
            return
        if (
            self.current is None
            or coefficient.current is None
            or coefficient.current_decay is None
            or coefficient.current_new is None
            or coefficient.current_old is None
        ):
            raise RuntimeError("dispersive FDTD coefficients are incomplete")
        old_electric = self.electric.clone()
        old_current = self.current.clone()
        curls = (((2, 1), (1, 2)), ((0, 2), (2, 0)), ((1, 0), (0, 1)))
        for component, (first, second) in enumerate(curls):
            derivative_a = self._derivative("electric", *first, False)
            derivative_b = self._derivative("electric", *second, False)
            self.electric[component].copy_(
                coefficient.previous[component] * old_electric[component]
                + coefficient.curl[component] * (derivative_a - derivative_b)
                + coefficient.current[component] * old_current[component]
            )
        self.current.copy_(
            coefficient.current_decay * old_current
            + coefficient.current_new * self.electric
            + coefficient.current_old * old_electric
        )

    def _derivative(
        self,
        kind: str,
        field_component: int,
        axis: int,
        forward: bool,
    ) -> torch.Tensor:
        field = self.electric if kind == "magnetic" else self.magnetic
        spacing = self._uniform_widths[axis]
        if spacing is None:
            function = forward_difference if forward else backward_difference
            derivative = function(
                field[field_component],
                self.widths[axis],
                axis,
                self.periodic[axis],
            )
        else:
            derivative = _uniform_difference(
                field[field_component],
                spacing,
                axis,
                self.periodic[axis],
                forward,
            )
        if self.cpml is not None:
            derivative = self.cpml.correct(kind, field_component, axis, derivative)
        return derivative


def _uniform_difference(
    values: torch.Tensor,
    spacing: float,
    axis: int,
    periodic: bool,
    forward: bool,
) -> torch.Tensor:
    dimension = _axis_dimension(axis)
    result = torch.zeros_like(values)
    current = [slice(None)] * values.ndim
    adjacent = [slice(None)] * values.ndim
    if forward:
        current[dimension] = slice(0, -1)
        adjacent[dimension] = slice(1, None)
        result[tuple(current)] = (
            values[tuple(adjacent)] - values[tuple(current)]
        ) / spacing
        boundary_index, opposite_index = -1, 0
        sign = 1.0
    else:
        current[dimension] = slice(1, None)
        adjacent[dimension] = slice(0, -1)
        result[tuple(current)] = (
            values[tuple(current)] - values[tuple(adjacent)]
        ) / spacing
        boundary_index, opposite_index = 0, -1
        sign = -1.0
    if periodic:
        boundary = [slice(None)] * values.ndim
        opposite = [slice(None)] * values.ndim
        boundary[dimension] = boundary_index
        opposite[dimension] = opposite_index
        result[tuple(boundary)] = sign * (
            values[tuple(opposite)] - values[tuple(boundary)]
        ) / spacing
    return result


__all__ = [
    "EPSILON_0",
    "FDTDEngine",
    "ElectricUpdateCoefficients",
    "LIGHT_SPEED",
    "MU_0",
    "backward_difference",
    "cell_center_fields",
    "forward_difference",
    "transverse_edge_average",
]
