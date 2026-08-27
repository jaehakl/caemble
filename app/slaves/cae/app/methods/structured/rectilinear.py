from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from itertools import product

from app.methods.structured.box import Offset


@dataclass(frozen=True, slots=True)
class AxisSegment:
    minimum: float
    maximum: float
    cell_count: int
    tag: str = "core"

    def __post_init__(self) -> None:
        if not math.isfinite(self.minimum) or not math.isfinite(self.maximum):
            raise ValueError("axis segment bounds must be finite")
        if self.maximum <= self.minimum or self.cell_count <= 0:
            raise ValueError("axis segment extent and cell count must be positive")
        if not self.tag:
            raise ValueError("axis segment tag must not be empty")

    @property
    def cell_size(self) -> float:
        return (self.maximum - self.minimum) / self.cell_count

    @property
    def boundary_ticks(self) -> tuple[float, ...]:
        spacing = self.cell_size
        return tuple(
            self.minimum + index * spacing if index < self.cell_count else self.maximum
            for index in range(self.cell_count + 1)
        )

    @property
    def cell_ticks(self) -> tuple[float, ...]:
        spacing = self.cell_size
        return tuple(
            self.minimum + (index + 0.5) * spacing for index in range(self.cell_count)
        )


@dataclass(frozen=True, slots=True)
class RectilinearBlock:
    index: tuple[int, ...]
    segments: tuple[AxisSegment, ...]
    global_slices: tuple[slice, ...]
    neighbors: Mapping[Offset, tuple[int, ...]] = field(default_factory=dict)

    @property
    def ndim(self) -> int:
        return len(self.segments)

    @property
    def shape(self) -> tuple[int, ...]:
        return tuple(segment.cell_count for segment in self.segments)

    @property
    def bounds(self) -> tuple[tuple[float, float], ...]:
        return tuple((segment.minimum, segment.maximum) for segment in self.segments)

    @property
    def cell_sizes(self) -> tuple[float, ...]:
        return tuple(segment.cell_size for segment in self.segments)

    @property
    def tags(self) -> frozenset[str]:
        return frozenset(segment.tag for segment in self.segments)


@dataclass(frozen=True, slots=True)
class RectilinearTopology:
    axes: tuple[tuple[AxisSegment, ...], ...]
    periodic: tuple[bool, ...] = ()
    blocks: tuple[RectilinearBlock, ...] = field(init=False)
    _blocks_by_index: dict[tuple[int, ...], RectilinearBlock] = field(
        init=False,
        repr=False,
        compare=False,
    )

    def __post_init__(self) -> None:
        axes = tuple(tuple(axis) for axis in self.axes)
        if not axes or any(not axis for axis in axes):
            raise ValueError("rectilinear topology axes must contain at least one segment")
        periodic = self.periodic or (False,) * len(axes)
        if len(periodic) != len(axes):
            raise ValueError("topology axes and periodicity must have matching dimensions")
        for axis in axes:
            for left, right in zip(axis, axis[1:], strict=False):
                if not math.isclose(left.maximum, right.minimum, rel_tol=1e-12, abs_tol=1e-12):
                    raise ValueError("axis segments must be contiguous and ordered")

        offsets: list[tuple[int, ...]] = []
        for axis in axes:
            starts: list[int] = []
            start = 0
            for segment in axis:
                starts.append(start)
                start += segment.cell_count
            offsets.append(tuple(starts))

        blocks: list[RectilinearBlock] = []
        for index in product(*(range(len(axis)) for axis in axes)):
            segments = tuple(axes[axis][position] for axis, position in enumerate(index))
            global_slices = tuple(
                slice(
                    offsets[axis][position],
                    offsets[axis][position] + segments[axis].cell_count,
                )
                for axis, position in enumerate(index)
            )
            neighbors: dict[Offset, tuple[int, ...]] = {}
            for axis, position in enumerate(index):
                for side in (-1, 1):
                    adjacent = position + side
                    if adjacent < 0 or adjacent >= len(axes[axis]):
                        if not periodic[axis]:
                            continue
                        adjacent %= len(axes[axis])
                    offset = [0] * len(axes)
                    offset[axis] = side
                    neighbor = list(index)
                    neighbor[axis] = adjacent
                    neighbors[tuple(offset)] = tuple(neighbor)
            blocks.append(RectilinearBlock(tuple(index), segments, global_slices, neighbors))

        object.__setattr__(self, "axes", axes)
        object.__setattr__(self, "periodic", tuple(periodic))
        object.__setattr__(self, "blocks", tuple(blocks))
        object.__setattr__(self, "_blocks_by_index", {block.index: block for block in blocks})

    @property
    def ndim(self) -> int:
        return len(self.axes)

    @property
    def global_shape(self) -> tuple[int, ...]:
        return tuple(sum(segment.cell_count for segment in axis) for axis in self.axes)

    @property
    def bounds(self) -> tuple[tuple[float, float], ...]:
        return tuple((axis[0].minimum, axis[-1].maximum) for axis in self.axes)

    def block(self, index: tuple[int, ...]) -> RectilinearBlock:
        return self._blocks_by_index[index]

    def boundary_ticks(self, axis: int) -> tuple[float, ...]:
        segments = self.axes[axis]
        return segments[0].boundary_ticks + tuple(
            tick for segment in segments[1:] for tick in segment.boundary_ticks[1:]
        )

    def cell_ticks(self, axis: int) -> tuple[float, ...]:
        return tuple(tick for segment in self.axes[axis] for tick in segment.cell_ticks)
