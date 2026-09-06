"""Runtime graph nodes; detached solver values live in api.values."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

import numpy as np

from app.runtime_kernel.api.values import FieldLocation


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


@dataclass(frozen=True, slots=True)
class ResourceRef:
    store_id: str
    resource_id: str


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


ResourceTreeRef = ResourceRef

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
