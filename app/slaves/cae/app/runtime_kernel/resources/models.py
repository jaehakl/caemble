from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field as dataclass_field
from enum import StrEnum
from typing import Any

import numpy as np


class ResourceKind(StrEnum):
    SCALAR = "scalar"
    MAPPING = "mapping"
    SEQUENCE = "sequence"
    TENSOR = "tensor"
    STRUCTURED_GRID = "structured-grid"
    UNSTRUCTURED_MESH = "unstructured-mesh"
    FIELD = "field"
    PARTICLE_SET = "particle-set"
    RAY_SET = "ray-set"
    STRUCTURED_BUNDLE = "structured-bundle"


class FieldLocation(StrEnum):
    NODE = "node"
    EDGE = "edge"
    FACE = "face"
    CELL = "cell"
    PARTICLE = "particle"
    RAY = "ray"


@dataclass(frozen=True, slots=True)
class ResourceRef:
    store_id: str
    resource_id: str


ResourceTreeRef = ResourceRef


@dataclass(frozen=True, slots=True)
class ResourceLease:
    store_id: str
    lease_id: str
    resource_ref: ResourceRef
    owner: str | None = None


@dataclass(frozen=True, slots=True)
class ScalarResource:
    value: Any
    kind: ResourceKind = ResourceKind.SCALAR


@dataclass(frozen=True, slots=True)
class MappingResource:
    items: tuple[tuple[Any, ResourceRef], ...]
    kind: ResourceKind = ResourceKind.MAPPING


@dataclass(frozen=True, slots=True)
class SequenceResource:
    items: tuple[ResourceRef, ...]
    sequence_type: str
    kind: ResourceKind = ResourceKind.SEQUENCE


@dataclass(frozen=True, slots=True)
class TensorResource:
    array: np.ndarray[Any, Any]
    kind: ResourceKind = ResourceKind.TENSOR


@dataclass(frozen=True, slots=True)
class StructuredGrid:
    shape: tuple[int, ...]
    axes: tuple[np.ndarray[Any, Any] | ResourceRef, ...]
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
class UnstructuredMesh:
    points: np.ndarray[Any, Any] | ResourceRef
    cells: np.ndarray[Any, Any] | Mapping[str, np.ndarray[Any, Any]] | ResourceRef
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
class Field:
    domain_ref: ResourceRef
    location: FieldLocation | str
    quantity_kind: str
    unit: str
    values: np.ndarray[Any, Any] | ResourceRef
    basis: Any = None
    components: tuple[str, ...] | None = None
    metadata: Mapping[str, Any] = dataclass_field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.domain_ref, ResourceRef):
            raise TypeError("field domain_ref must be a ResourceRef")
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


@dataclass(frozen=True, slots=True)
class ParticleSet:
    positions: np.ndarray[Any, Any] | ResourceRef
    unit: str
    attributes: Mapping[str, np.ndarray[Any, Any] | ResourceRef] = dataclass_field(
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
class RaySet:
    origins: np.ndarray[Any, Any] | ResourceRef
    directions: np.ndarray[Any, Any] | ResourceRef
    unit: str
    attributes: Mapping[str, np.ndarray[Any, Any] | ResourceRef] = dataclass_field(
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
class StructuredBundle:
    bundle_type: str
    members: Mapping[str, Any]
    metadata: Mapping[str, Any] = dataclass_field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.bundle_type, str) or not self.bundle_type:
            raise ValueError("structured bundle type must be a non-empty string")
        _validate_named_values("structured bundle members", self.members)
        _validate_metadata(self.metadata)


@dataclass(frozen=True, slots=True)
class StructuredGridResource:
    shape: tuple[int, ...]
    axes: tuple[ResourceRef, ...]
    unit: str
    identity: str | None
    metadata: ResourceRef
    wire: ResourceRef | None = None
    kind: ResourceKind = ResourceKind.STRUCTURED_GRID


@dataclass(frozen=True, slots=True)
class UnstructuredMeshResource:
    points: ResourceRef
    cells: ResourceRef
    unit: str
    identity: str | None
    metadata: ResourceRef
    kind: ResourceKind = ResourceKind.UNSTRUCTURED_MESH


@dataclass(frozen=True, slots=True)
class FieldResource:
    domain_ref: ResourceRef
    location: FieldLocation
    quantity_kind: str
    unit: str
    values: ResourceRef
    basis: ResourceRef | None
    components: tuple[str, ...] | None
    metadata: ResourceRef
    wire: ResourceRef | None = None
    kind: ResourceKind = ResourceKind.FIELD


@dataclass(frozen=True, slots=True)
class ParticleSetResource:
    positions: ResourceRef
    unit: str
    attributes: ResourceRef
    identity: str | None
    metadata: ResourceRef
    kind: ResourceKind = ResourceKind.PARTICLE_SET


@dataclass(frozen=True, slots=True)
class RaySetResource:
    origins: ResourceRef
    directions: ResourceRef
    unit: str
    attributes: ResourceRef
    identity: str | None
    metadata: ResourceRef
    kind: ResourceKind = ResourceKind.RAY_SET


@dataclass(frozen=True, slots=True)
class StructuredBundleResource:
    bundle_type: str
    members: ResourceRef
    metadata: ResourceRef
    wire: ResourceRef | None = None
    kind: ResourceKind = ResourceKind.STRUCTURED_BUNDLE


ResourceValue = StructuredGrid | UnstructuredMesh | Field | ParticleSet | RaySet | StructuredBundle
ResourceNode = (
    ScalarResource
    | MappingResource
    | SequenceResource
    | TensorResource
    | StructuredGridResource
    | UnstructuredMeshResource
    | FieldResource
    | ParticleSetResource
    | RaySetResource
    | StructuredBundleResource
)


@dataclass(frozen=True, slots=True)
class ResourceDescription:
    ref: ResourceRef
    kind: ResourceKind
    children: tuple[ResourceRef, ...]
    dtype: str | None = None
    shape: tuple[int, ...] | None = None
    metadata: Mapping[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class ResourceStoreStats:
    resource_count: int
    lease_count: int


class ResourceError(RuntimeError):
    pass


class ResourceScopeError(ResourceError):
    pass


class ResourceNotFoundError(ResourceError):
    pass


class ResourceLeaseError(ResourceError):
    pass


class CyclicResourceError(ResourceError):
    pass


class ResourceValidationError(ResourceError, ValueError):
    pass


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
