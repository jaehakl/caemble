from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from app.methods.structured import AxisSegment, RectilinearTopology

Bounds3D = tuple[tuple[float, float], tuple[float, float], tuple[float, float]]
BlockKind = Literal["main", "buffer", "pml"]


def _ceil_cell_count(length: float, cell_size: float) -> int:
    return math.ceil(math.nextafter(length / cell_size, -math.inf))


@dataclass(frozen=True, slots=True)
class FDTDRegion:
    bounds: Bounds3D
    background: Any
    model: str

    def __post_init__(self) -> None:
        if len(self.bounds) != 3 or any(len(axis) != 2 for axis in self.bounds):
            raise ValueError("FDTD regions must have three Cartesian axis bounds")
        if any(
            not math.isfinite(minimum)
            or not math.isfinite(maximum)
            or maximum <= minimum
            for minimum, maximum in self.bounds
        ):
            raise ValueError("FDTD region bounds must be finite and increasing")


@dataclass(frozen=True, slots=True)
class FDTDBlockMetadata:
    kind: BlockKind
    background: Any
    model: str
    inherited_from: tuple[int, int, int]


@dataclass(frozen=True, slots=True)
class FDTDDomain:
    topology: RectilinearTopology
    blocks: Mapping[tuple[int, int, int], FDTDBlockMetadata]
    requested_main_bounds: Bounds3D
    expanded_main_bounds: Bounds3D
    core_bounds: Bounds3D

    @property
    def cell_ticks(self) -> tuple[tuple[float, ...], tuple[float, ...], tuple[float, ...]]:
        return (
            self.topology.cell_ticks(0),
            self.topology.cell_ticks(1),
            self.topology.cell_ticks(2),
        )

    @property
    def boundary_ticks(self) -> tuple[tuple[float, ...], tuple[float, ...], tuple[float, ...]]:
        return (
            self.topology.boundary_ticks(0),
            self.topology.boundary_ticks(1),
            self.topology.boundary_ticks(2),
        )


def build_fdtd_domain(
    main: FDTDRegion,
    main_cell_sizes: tuple[float, float, float],
    *,
    buffer: FDTDRegion | None = None,
    buffer_cell_size: float | None = None,
    periodic: tuple[bool, bool, bool] = (False, False, False),
    pml_thickness: float,
    pml_cell_size: float,
) -> FDTDDomain:
    if len(main_cell_sizes) != 3 or any(
        not math.isfinite(cell_size) or cell_size <= 0 for cell_size in main_cell_sizes
    ):
        raise ValueError("main cell sizes must be three positive finite values")
    if len(periodic) != 3:
        raise ValueError("periodicity must contain x, y, and z flags")
    if not math.isfinite(pml_thickness) or pml_thickness <= 0:
        raise ValueError("PML thickness must be positive and finite")
    if not math.isfinite(pml_cell_size) or pml_cell_size <= 0:
        raise ValueError("PML cell size must be positive and finite")
    if (buffer is None) != (buffer_cell_size is None):
        raise ValueError("buffer region and cell size must be provided together")
    if buffer_cell_size is not None and (
        not math.isfinite(buffer_cell_size)
        or buffer_cell_size <= max(main_cell_sizes)
    ):
        raise ValueError("buffer cell size must be larger than every main cell size")

    expanded_main: list[tuple[float, float]] = []
    main_counts: list[int] = []
    for (minimum, maximum), cell_size in zip(main.bounds, main_cell_sizes, strict=True):
        cell_count = _ceil_cell_count(maximum - minimum, cell_size)
        center = (minimum + maximum) / 2
        half_extent = cell_count * cell_size / 2
        expanded_main.append((center - half_extent, center + half_extent))
        main_counts.append(cell_count)
    expanded_main_bounds = tuple(expanded_main)

    if buffer is not None and any(
        buffer.bounds[axis][0] > expanded_main_bounds[axis][0]
        or buffer.bounds[axis][1] < expanded_main_bounds[axis][1]
        for axis in range(3)
    ):
        raise ValueError("buffer region must contain the expanded main region")

    core_axes: list[tuple[AxisSegment, ...]] = []
    for axis in range(3):
        main_minimum, main_maximum = expanded_main_bounds[axis]
        segments: list[AxisSegment] = []
        if buffer is not None and buffer_cell_size is not None:
            lower_count = _ceil_cell_count(
                main_minimum - buffer.bounds[axis][0],
                buffer_cell_size,
            )
            if lower_count > 1:
                segments.append(
                    AxisSegment(
                        main_minimum - lower_count * buffer_cell_size,
                        main_minimum,
                        lower_count,
                        "buffer",
                    )
                )
        segments.append(
            AxisSegment(
                main_minimum,
                main_maximum,
                main_counts[axis],
                "main",
            )
        )
        if buffer is not None and buffer_cell_size is not None:
            upper_count = _ceil_cell_count(
                buffer.bounds[axis][1] - main_maximum,
                buffer_cell_size,
            )
            if upper_count > 1:
                segments.append(
                    AxisSegment(
                        main_maximum,
                        main_maximum + upper_count * buffer_cell_size,
                        upper_count,
                        "buffer",
                    )
                )
        core_axes.append(tuple(segments))

    core_bounds = tuple((axis[0].minimum, axis[-1].maximum) for axis in core_axes)
    pml_count = _ceil_cell_count(pml_thickness, pml_cell_size)
    axes: list[tuple[AxisSegment, ...]] = []
    for axis, core_segments in enumerate(core_axes):
        segments = list(core_segments)
        if not periodic[axis]:
            segments.insert(
                0,
                AxisSegment(
                    core_segments[0].minimum - pml_count * pml_cell_size,
                    core_segments[0].minimum,
                    pml_count,
                    "pml",
                ),
            )
            segments.append(
                AxisSegment(
                    core_segments[-1].maximum,
                    core_segments[-1].maximum + pml_count * pml_cell_size,
                    pml_count,
                    "pml",
                )
            )
        axes.append(tuple(segments))

    topology = RectilinearTopology(tuple(axes), periodic)
    blocks: dict[tuple[int, int, int], FDTDBlockMetadata] = {}
    for block in topology.blocks:
        core_index = list(block.index)
        has_pml = False
        for axis, segment in enumerate(block.segments):
            if segment.tag != "pml":
                continue
            has_pml = True
            core_positions = [
                index for index, item in enumerate(topology.axes[axis]) if item.tag != "pml"
            ]
            core_index[axis] = core_positions[0] if block.index[axis] < core_positions[0] else core_positions[-1]
        inherited_from = tuple(core_index)
        inherited_block = topology.block(inherited_from)
        inherited_is_buffer = any(segment.tag == "buffer" for segment in inherited_block.segments)
        background_region = buffer if inherited_is_buffer and buffer is not None else main
        kind: BlockKind = "pml" if has_pml else "buffer" if inherited_is_buffer else "main"
        blocks[block.index] = FDTDBlockMetadata(
            kind,
            background_region.background,
            background_region.model,
            inherited_from,
        )

    return FDTDDomain(
        topology,
        blocks,
        main.bounds,
        expanded_main_bounds,
        core_bounds,
    )
