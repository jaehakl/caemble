"""Compatibility imports; resource graph nodes live in ``nodes``."""

from app.runtime_kernel.api.values import (
    BundleValue as StructuredBundle,
    FieldLocation,
    FieldValue,
    ParticleSetValue as ParticleSet,
    RaySetValue as RaySet,
    StructuredGridValue as StructuredGrid,
    UnstructuredMeshValue as UnstructuredMesh,
)
from app.runtime_kernel.compat.payloads import Field
from app.runtime_kernel.resources.nodes import (
    ResourceKind,
    ResourceRef,
    ResourceLease,
    ScalarResource,
    MappingResource,
    SequenceResource,
    TensorResource,
    StructuredGridResource,
    UnstructuredMeshResource,
    FieldResource,
    ParticleSetResource,
    RaySetResource,
    StructuredBundleResource,
    ResourceDescription,
    ResourceStoreStats,
    ResourceError,
    ResourceScopeError,
    ResourceNotFoundError,
    ResourceLeaseError,
    CyclicResourceError,
    ResourceValidationError,
    ResourceTreeRef,
    ResourceNode,
)

ResourceValue = (
    StructuredGrid | UnstructuredMesh | FieldValue | Field
    | ParticleSet | RaySet | StructuredBundle
)
