"""Self-contained domain, field and bundle values crossing the solver boundary."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field as dataclass_field
from enum import StrEnum
from typing import Any, TypeAlias

import numpy as np


class FieldLocation(StrEnum):
    NODE = "node"
    EDGE = "edge"
    FACE = "face"
    CELL = "cell"
    PARTICLE = "particle"
    RAY = "ray"


@dataclass(frozen=True, slots=True)
class StructuredGridValue:
    shape: tuple[int, ...]
    axes: tuple[np.ndarray[Any, Any], ...]
    unit: str
    identity: str | None = None
    metadata: Mapping[str, Any] = dataclass_field(default_factory=dict)

    def __post_init__(self) -> None:
        shape = tuple(self.shape)
        axes = tuple(self.axes)
        if not shape or any(
            isinstance(size, bool) or not isinstance(size, int) or size <= 0
            for size in shape
        ):
            raise ValueError("structured grid shape must contain positive integers")
        if len(axes) != len(shape):
            raise ValueError("structured grid must have one axis per shape dimension")
        _validate_unit(self.unit)
        _validate_identity(self.identity)
        _validate_metadata(self.metadata)
        object.__setattr__(self, "shape", shape)
        object.__setattr__(self, "axes", axes)


@dataclass(frozen=True, slots=True)
class UnstructuredMeshValue:
    points: np.ndarray[Any, Any]
    cells: np.ndarray[Any, Any] | Mapping[str, np.ndarray[Any, Any]]
    unit: str
    identity: str | None = None
    metadata: Mapping[str, Any] = dataclass_field(default_factory=dict)

    def __post_init__(self) -> None:
        _validate_unit(self.unit)
        _validate_identity(self.identity)
        _validate_metadata(self.metadata)
        if isinstance(self.cells, Mapping):
            _validate_named_values("mesh cell blocks", self.cells)


@dataclass(frozen=True, slots=True)
class ParticleSetValue:
    positions: np.ndarray[Any, Any]
    unit: str
    attributes: Mapping[str, np.ndarray[Any, Any]] = dataclass_field(
        default_factory=dict
    )
    identity: str | None = None
    metadata: Mapping[str, Any] = dataclass_field(default_factory=dict)

    def __post_init__(self) -> None:
        _validate_unit(self.unit)
        _validate_identity(self.identity)
        _validate_named_values("particle attributes", self.attributes)
        _validate_metadata(self.metadata)


@dataclass(frozen=True, slots=True)
class RaySetValue:
    origins: np.ndarray[Any, Any]
    directions: np.ndarray[Any, Any]
    unit: str
    attributes: Mapping[str, np.ndarray[Any, Any]] = dataclass_field(
        default_factory=dict
    )
    identity: str | None = None
    metadata: Mapping[str, Any] = dataclass_field(default_factory=dict)

    def __post_init__(self) -> None:
        _validate_unit(self.unit)
        _validate_identity(self.identity)
        _validate_named_values("ray attributes", self.attributes)
        _validate_metadata(self.metadata)


@dataclass(frozen=True, slots=True)
class BundleValue:
    bundle_type: str
    members: Mapping[str, Any]
    metadata: Mapping[str, Any] = dataclass_field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.bundle_type, str) or not self.bundle_type:
            raise ValueError("structured bundle type must be a non-empty string")
        _validate_named_values("structured bundle members", self.members)
        _validate_metadata(self.metadata)


DomainValue: TypeAlias = (
    StructuredGridValue | UnstructuredMeshValue | ParticleSetValue | RaySetValue
)


@dataclass(frozen=True, slots=True)
class FieldValue:
    domain: DomainValue
    location: FieldLocation | str
    quantity_kind: str
    unit: str
    values: np.ndarray[Any, Any]
    basis: Any = None
    components: tuple[str, ...] | None = None
    metadata: Mapping[str, Any] = dataclass_field(default_factory=dict)

    def __post_init__(self) -> None:
        try:
            location = FieldLocation(self.location)
        except ValueError as error:
            raise ValueError(f"unsupported field location {self.location!r}") from error
        if not isinstance(self.quantity_kind, str) or not self.quantity_kind:
            raise ValueError("field quantity_kind must be a non-empty string")
        _validate_unit(self.unit)
        _validate_metadata(self.metadata)
        components = None if self.components is None else tuple(self.components)
        if components is not None and (
            not components
            or any(not isinstance(component, str) or not component for component in components)
            or len(set(components)) != len(components)
        ):
            raise ValueError("field components must be unique non-empty strings")
        object.__setattr__(self, "location", location)
        object.__setattr__(self, "components", components)


def _validate_unit(unit: str) -> None:
    if not isinstance(unit, str) or not unit:
        raise ValueError("resource unit must be a non-empty UCUM string")


def _validate_identity(identity: str | None) -> None:
    if identity is not None and (not isinstance(identity, str) or not identity):
        raise ValueError("resource identity must be a non-empty string when present")


def _validate_metadata(metadata: Mapping[str, Any]) -> None:
    if not isinstance(metadata, Mapping) or any(
        not isinstance(key, str) or not key for key in metadata
    ):
        raise ValueError("resource metadata must use non-empty string keys")


def _validate_named_values(name: str, values: Mapping[str, Any]) -> None:
    if not isinstance(values, Mapping) or any(
        not isinstance(key, str) or not key for key in values
    ):
        raise ValueError(f"{name} must use non-empty string keys")
