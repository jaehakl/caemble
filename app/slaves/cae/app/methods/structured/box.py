from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, TypeVar

from app.methods.fields import Field

Result = TypeVar("Result")
Offset = tuple[int, ...]


@dataclass(frozen=True, slots=True)
class Partition:
    shape: tuple[int, ...]
    offset: tuple[int, ...] = ()
    index: tuple[int, ...] = ()
    neighbors: Mapping[Offset, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.offset:
            object.__setattr__(self, "offset", (0,) * len(self.shape))
        if len(self.offset) != len(self.shape):
            raise ValueError("partition shape and offset must have the same dimensionality")

    @property
    def ndim(self) -> int:
        return len(self.shape)


@dataclass(frozen=True, slots=True)
class Halo:
    width: tuple[int, ...]
    periodic: tuple[bool, ...] = ()

    def __post_init__(self) -> None:
        if not self.periodic:
            object.__setattr__(self, "periodic", (False,) * len(self.width))
        if len(self.periodic) != len(self.width) or any(padding < 0 for padding in self.width):
            raise ValueError("halo width and periodicity must have matching, non-negative dimensions")

    def storage_shape(self, partition: Partition) -> tuple[int, ...]:
        return tuple(size + 2 * padding for size, padding in zip(partition.shape, self.width, strict=True))

    def interior(self, partition: Partition) -> tuple[slice, ...]:
        return tuple(
            slice(padding, padding + size)
            for size, padding in zip(partition.shape, self.width, strict=True)
        )

    def face_slices(
        self,
        partition: Partition,
        axis: int,
        side: int,
    ) -> tuple[tuple[slice, ...], tuple[slice, ...]]:
        if side not in (-1, 1):
            raise ValueError("halo face side must be -1 or 1")
        send = list(self.interior(partition))
        receive = list(send)
        padding = self.width[axis]
        start = padding
        stop = padding + partition.shape[axis]
        if side < 0:
            send[axis] = slice(start, start + padding)
            receive[axis] = slice(0, padding)
        else:
            send[axis] = slice(stop - padding, stop)
            receive[axis] = slice(stop, stop + padding)
        return tuple(send), tuple(receive)


@dataclass(frozen=True, slots=True)
class StencilTerm:
    offset: Offset
    coefficient: float


@dataclass(frozen=True, slots=True)
class Stencil:
    terms: tuple[StencilTerm, ...]

    def __post_init__(self) -> None:
        if self.terms and any(len(term.offset) != len(self.terms[0].offset) for term in self.terms):
            raise ValueError("all stencil offsets must have the same dimensionality")

    @property
    def radius(self) -> tuple[int, ...]:
        dimensions = len(self.terms[0].offset) if self.terms else 0
        return tuple(max(abs(term.offset[axis]) for term in self.terms) for axis in range(dimensions))


@dataclass(slots=True)
class Box:
    partition: Partition
    halo: Halo
    fields: dict[str, Field] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    def add(self, value: Field) -> Field:
        self.fields[value.name] = value
        return value

    def field(self, name: str) -> Field:
        return self.fields[name]

    def apply(self, operator: Callable[..., Result], *args: Any, **kwargs: Any) -> Result:
        return operator(self, *args, **kwargs)

    def exchange(
        self,
        exchanger: Callable[[Field, Partition, Halo], Any],
        names: tuple[str, ...] | None = None,
    ) -> None:
        for name in names or tuple(self.fields):
            exchanger(self.fields[name], self.partition, self.halo)
