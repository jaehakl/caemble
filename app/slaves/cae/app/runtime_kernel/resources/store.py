from __future__ import annotations

import copy
import threading
import uuid
from collections.abc import Hashable, Mapping, Sequence
from types import MappingProxyType
from typing import Any

import numpy as np

from app.runtime_kernel.resources.buffers import BufferLease, BufferStore
from app.runtime_kernel.resources.models import (
    CyclicResourceError,
    Field,
    FieldLocation,
    FieldResource,
    MappingResource,
    ParticleSet,
    ParticleSetResource,
    RaySet,
    RaySetResource,
    ResourceDescription,
    ResourceKind,
    ResourceLease,
    ResourceLeaseError,
    ResourceNode,
    ResourceNotFoundError,
    ResourceRef,
    ResourceScopeError,
    ResourceStoreStats,
    ResourceValidationError,
    ScalarResource,
    SequenceResource,
    StructuredBundle,
    StructuredBundleResource,
    StructuredGrid,
    StructuredGridResource,
    TensorResource,
    UnstructuredMesh,
    UnstructuredMeshResource,
)

StatePath = tuple[Hashable, ...]
_DELETE = object()
_STRUCTURED_GRID_TAG = "caemble.structured-grid/v1"
_STRUCTURED_FIELD_TAG = "caemble.structured-field/v1"
_RAY_PATH_BUNDLE_TAG = "caemble.ray-path-bundle/v1"


class ResourceStore:
    """Run-scoped immutable resource graph with explicit root leases."""

    def __init__(self, store_id: str | None = None) -> None:
        self.store_id = store_id or f"resources-{uuid.uuid4()}"
        self._nodes: dict[str, ResourceNode] = {}
        self._inbound_references: dict[str, int] = {}
        self._leases: dict[str, ResourceLease] = {}
        self._lease_counts: dict[str, int] = {}
        self._buffer_leases: dict[str, BufferLease] = {}
        self._sequence = 0
        self._closed = False
        self._lock = threading.RLock()

    def ingest(self, value: Any, *, copy_arrays: bool = True) -> ResourceRef:
        return self.ingest_many((value,), copy_arrays=copy_arrays)[0]

    def ingest_many(
        self,
        values: Sequence[Any],
        *,
        copy_arrays: bool = True,
    ) -> tuple[ResourceRef, ...]:
        """Ingest several roots in one transaction, preserving aliases between them."""
        with self._lock:
            self._ensure_open()
            memo: dict[int, ResourceRef] = {}
            active: set[int] = set()
            created: list[str] = []
            try:
                return tuple(
                    self._ingest(value, memo, active, created, copy_arrays) for value in values
                )
            except BaseException:
                self._rollback_created(created)
                raise

    def resolve(self, ref: ResourceRef) -> Any:
        """Return an immutable Python view of a resource tree."""
        with self._lock:
            self._validate_ref(ref)
            return self._resolve(ref, {})

    def materialize(
        self,
        ref: ResourceRef,
        *,
        mutable: bool = True,
        copy_arrays: bool = True,
    ) -> Any:
        """Export a detached Python tree, normally for a legacy solver boundary."""
        if not mutable:
            return self.resolve(ref)
        with self._lock:
            self._validate_ref(ref)
            return self._materialize_mutable(ref, {}, copy_arrays)

    def acquire(self, ref: ResourceRef, *, owner: str | None = None) -> ResourceLease:
        with self._lock:
            self._validate_ref(ref)
            lease = ResourceLease(
                store_id=self.store_id,
                lease_id=f"lease-{uuid.uuid4()}",
                resource_ref=ref,
                owner=owner,
            )
            self._leases[lease.lease_id] = lease
            self._lease_counts[ref.resource_id] = self._lease_counts.get(ref.resource_id, 0) + 1
            return lease

    def release(self, lease: ResourceLease) -> None:
        with self._lock:
            self._ensure_open()
            if lease.store_id != self.store_id:
                raise ResourceScopeError("resource lease belongs to another store")
            registered = self._leases.get(lease.lease_id)
            if registered != lease:
                raise ResourceLeaseError("resource lease is not live")
            del self._leases[lease.lease_id]
            resource_id = lease.resource_ref.resource_id
            count = self._lease_counts[resource_id] - 1
            if count:
                self._lease_counts[resource_id] = count
            else:
                del self._lease_counts[resource_id]
            self._collect(resource_id)

    def discard(self, ref: ResourceRef) -> bool:
        """Collect an unleased, unreferenced provisional root."""
        with self._lock:
            self._validate_ref(ref)
            resource_id = ref.resource_id
            if self._lease_counts.get(resource_id, 0) or self._inbound_references[resource_id]:
                return False
            self._collect(resource_id)
            return True

    def put_path(
        self,
        root: ResourceRef,
        path: StatePath,
        value: Any,
        *,
        copy_arrays: bool = True,
    ) -> ResourceRef:
        with self._lock:
            self._validate_ref(root)
            replacement = self.ingest(value, copy_arrays=copy_arrays)
            try:
                return self._rewrite(root, tuple(path), 0, replacement)
            except BaseException:
                if replacement.resource_id in self._nodes:
                    self.discard(replacement)
                raise

    def delete_path(self, root: ResourceRef, path: StatePath) -> ResourceRef:
        if not path:
            raise ValueError("the state root cannot be deleted")
        with self._lock:
            self._validate_ref(root)
            rewritten = self._rewrite(root, tuple(path), 0, _DELETE)
            if rewritten is _DELETE:
                raise ValueError("the state root cannot be deleted")
            return rewritten

    def kind(self, ref: ResourceRef) -> ResourceKind:
        with self._lock:
            return self._node(ref).kind

    def describe(self, ref: ResourceRef) -> ResourceDescription:
        with self._lock:
            node = self._node(ref)
            children = self._children(node)
            if isinstance(node, TensorResource):
                return ResourceDescription(
                    ref,
                    node.kind,
                    children,
                    str(node.array.dtype),
                    tuple(node.array.shape),
                )
            if isinstance(node, StructuredGridResource):
                return ResourceDescription(
                    ref,
                    node.kind,
                    children,
                    shape=node.shape,
                    metadata=self._resource_metadata(
                        node.metadata,
                        unit=node.unit,
                        identity=node.identity,
                    ),
                )
            if isinstance(node, UnstructuredMeshResource):
                points = self._tensor(node.points, "mesh points")
                return ResourceDescription(
                    ref,
                    node.kind,
                    children,
                    str(points.dtype),
                    tuple(points.shape),
                    self._resource_metadata(
                        node.metadata,
                        unit=node.unit,
                        identity=node.identity,
                    ),
                )
            if isinstance(node, FieldResource):
                values = self._tensor(node.values, "field values")
                basis = None if node.basis is None else self._resolve(node.basis, {})
                return ResourceDescription(
                    ref,
                    node.kind,
                    children,
                    str(values.dtype),
                    tuple(values.shape),
                    self._resource_metadata(
                        node.metadata,
                        domainRef=node.domain_ref,
                        location=node.location.value,
                        quantityKind=node.quantity_kind,
                        unit=node.unit,
                        basis=basis,
                        components=node.components,
                    ),
                )
            if isinstance(node, ParticleSetResource):
                positions = self._tensor(node.positions, "particle positions")
                return ResourceDescription(
                    ref,
                    node.kind,
                    children,
                    str(positions.dtype),
                    tuple(positions.shape),
                    self._resource_metadata(
                        node.metadata,
                        unit=node.unit,
                        identity=node.identity,
                        count=positions.shape[0],
                    ),
                )
            if isinstance(node, RaySetResource):
                origins = self._tensor(node.origins, "ray origins")
                return ResourceDescription(
                    ref,
                    node.kind,
                    children,
                    str(origins.dtype),
                    tuple(origins.shape),
                    self._resource_metadata(
                        node.metadata,
                        unit=node.unit,
                        identity=node.identity,
                        count=origins.shape[0],
                    ),
                )
            if isinstance(node, StructuredBundleResource):
                members = self._node(node.members)
                member_names = (
                    tuple(key for key, _ in members.items)
                    if isinstance(members, MappingResource)
                    else ()
                )
                return ResourceDescription(
                    ref,
                    node.kind,
                    children,
                    metadata=self._resource_metadata(
                        node.metadata,
                        bundleType=node.bundle_type,
                        members=member_names,
                    ),
                )
            return ResourceDescription(ref, node.kind, children)

    def contains(self, ref: ResourceRef) -> bool:
        with self._lock:
            return (
                not self._closed
                and ref.store_id == self.store_id
                and ref.resource_id in self._nodes
            )

    def lease_count(self, ref: ResourceRef) -> int:
        with self._lock:
            self._validate_ref(ref)
            return self._lease_counts.get(ref.resource_id, 0)

    def reference_count(self, ref: ResourceRef) -> int:
        with self._lock:
            self._validate_ref(ref)
            return self._inbound_references[ref.resource_id]

    def stats(self) -> ResourceStoreStats:
        with self._lock:
            return ResourceStoreStats(len(self._nodes), len(self._leases))

    def close(self) -> None:
        with self._lock:
            for resource_id in tuple(self._buffer_leases):
                self._release_buffer_lease(resource_id)
            self._leases.clear()
            self._lease_counts.clear()
            self._nodes.clear()
            self._inbound_references.clear()
            self._closed = True

    def _ingest(
        self,
        value: Any,
        memo: dict[int, ResourceRef],
        active: set[int],
        created: list[str],
        copy_arrays: bool,
    ) -> ResourceRef:
        if isinstance(value, ResourceRef):
            self._validate_ref(value)
            return value

        tracked = isinstance(
            value,
            (
                Mapping,
                list,
                tuple,
                np.ndarray,
                StructuredGrid,
                UnstructuredMesh,
                Field,
                ParticleSet,
                RaySet,
                StructuredBundle,
            ),
        )
        value_id = id(value)
        if tracked and value_id in memo:
            return memo[value_id]
        if tracked and value_id in active:
            raise CyclicResourceError("cyclic mappings and sequences are not supported")
        if tracked:
            active.add(value_id)

        try:
            if isinstance(value, np.ndarray):
                array = np.array(value, copy=copy_arrays, order="K", subok=True)
                array.flags.writeable = False
                ref = self._add_node(TensorResource(array), created)
            elif isinstance(value, StructuredGrid):
                ref = self._ingest_structured_grid(
                    value,
                    memo,
                    active,
                    created,
                    copy_arrays,
                )
            elif isinstance(value, UnstructuredMesh):
                ref = self._ingest_unstructured_mesh(
                    value,
                    memo,
                    active,
                    created,
                    copy_arrays,
                )
            elif isinstance(value, Field):
                ref = self._ingest_field(value, memo, active, created, copy_arrays)
            elif isinstance(value, ParticleSet):
                ref = self._ingest_particle_set(
                    value,
                    memo,
                    active,
                    created,
                    copy_arrays,
                )
            elif isinstance(value, RaySet):
                ref = self._ingest_ray_set(value, memo, active, created, copy_arrays)
            elif isinstance(value, StructuredBundle):
                ref = self._ingest_structured_bundle(
                    value,
                    memo,
                    active,
                    created,
                    copy_arrays,
                )
            elif isinstance(value, Mapping) and value.get("kind") == _STRUCTURED_GRID_TAG:
                ref = self._ingest_tagged_structured_grid(
                    value,
                    memo,
                    active,
                    created,
                    copy_arrays,
                )
            elif isinstance(value, Mapping) and value.get("kind") == _STRUCTURED_FIELD_TAG:
                ref = self._ingest_tagged_structured_field(
                    value,
                    memo,
                    active,
                    created,
                    copy_arrays,
                )
            elif isinstance(value, Mapping) and value.get("kind") == _RAY_PATH_BUNDLE_TAG:
                ref = self._ingest_tagged_structured_bundle(
                    value,
                    memo,
                    active,
                    created,
                    copy_arrays,
                )
            elif isinstance(value, Mapping):
                ref = self._ingest_plain_mapping(
                    value,
                    memo,
                    active,
                    created,
                    copy_arrays,
                )
            elif isinstance(value, (list, tuple)):
                items = tuple(
                    self._ingest(item, memo, active, created, copy_arrays) for item in value
                )
                ref = self._add_node(
                    SequenceResource(items, "tuple" if isinstance(value, tuple) else "list"),
                    created,
                )
            else:
                ref = self._add_node(ScalarResource(copy.deepcopy(value)), created)
        finally:
            if tracked:
                active.discard(value_id)

        if tracked:
            memo[value_id] = ref
        return ref

    def _ingest_plain_mapping(
        self,
        value: Mapping[Any, Any],
        memo: dict[int, ResourceRef],
        active: set[int],
        created: list[str],
        copy_arrays: bool,
    ) -> ResourceRef:
        return self._add_node(
            MappingResource(
                tuple(
                    (
                        copy.deepcopy(key),
                        self._ingest(item, memo, active, created, copy_arrays),
                    )
                    for key, item in value.items()
                )
            ),
            created,
        )

    def _ingest_tagged_structured_grid(
        self,
        value: Mapping[Any, Any],
        memo: dict[int, ResourceRef],
        active: set[int],
        created: list[str],
        copy_arrays: bool,
    ) -> ResourceRef:
        raw_shape = value.get("shape")
        raw_axes = value.get("axes")
        unit = value.get("referenceLengthUnit")
        identity = value.get("id")
        if not isinstance(raw_shape, (list, tuple)) or not raw_shape:
            raise ResourceValidationError("tagged structured grid must declare a shape")
        shape = tuple(raw_shape)
        if any(isinstance(size, bool) or not isinstance(size, int) or size <= 0 for size in shape):
            raise ResourceValidationError("tagged structured grid shape must contain positive integers")
        if not isinstance(raw_axes, (list, tuple)) or len(raw_axes) != len(shape):
            raise ResourceValidationError("tagged structured grid must have one axis per dimension")
        if not isinstance(unit, str) or not unit:
            raise ResourceValidationError("tagged structured grid must declare a reference length unit")
        if identity is not None and (not isinstance(identity, str) or not identity):
            raise ResourceValidationError("tagged structured grid identity must be a non-empty string")

        axes: list[ResourceRef] = []
        for index, (axis, size) in enumerate(zip(raw_axes, shape, strict=True)):
            if not isinstance(axis, Mapping) or "ticks" not in axis:
                raise ResourceValidationError(f"tagged structured grid axis {index} must declare ticks")
            ticks = np.asarray(axis["ticks"], dtype=np.float64)
            if ticks.ndim != 1 or ticks.shape[0] != size:
                raise ResourceValidationError(
                    f"tagged structured grid axis {index} must have shape ({size},)"
                )
            if not np.all(np.isfinite(ticks)):
                raise ResourceValidationError(
                    f"tagged structured grid axis {index} must contain finite coordinates"
                )
            differences = np.diff(ticks)
            if differences.size and not (
                np.all(differences > 0) or np.all(differences < 0)
            ):
                raise ResourceValidationError(
                    f"tagged structured grid axis {index} must be strictly monotonic"
                )
            axes.append(self._ingest(ticks, memo, active, created, copy_arrays))
        metadata = self._ingest(
            {"wireKind": _STRUCTURED_GRID_TAG},
            memo,
            active,
            created,
            copy_arrays,
        )
        wire = self._ingest_plain_mapping(value, memo, active, created, copy_arrays)
        return self._add_node(
            StructuredGridResource(shape, tuple(axes), unit, identity, metadata, wire),
            created,
        )

    def _ingest_tagged_structured_field(
        self,
        value: Mapping[Any, Any],
        memo: dict[int, ResourceRef],
        active: set[int],
        created: list[str],
        copy_arrays: bool,
    ) -> ResourceRef:
        domain = value.get("domainRef")
        if not isinstance(domain, Mapping):
            raise ResourceValidationError("tagged structured field must declare a domainRef")
        try:
            location = FieldLocation(value.get("location"))
        except ValueError as error:
            raise ResourceValidationError("tagged structured field has an invalid location") from error
        quantity_kind = value.get("quantityKind")
        unit = value.get("unit")
        if not isinstance(quantity_kind, str) or not quantity_kind:
            raise ResourceValidationError("tagged structured field must declare a QuantityKind")
        if not isinstance(unit, str) or not unit:
            raise ResourceValidationError("tagged structured field must declare a unit")
        if "value" not in value:
            raise ResourceValidationError("tagged structured field must contain values")

        wire = self._ingest_plain_mapping(value, memo, active, created, copy_arrays)
        wire_node = self._require_mapping(wire, "tagged structured field")
        children = dict(wire_node.items)
        domain_ref = children["domainRef"]
        if self.kind(domain_ref) is not ResourceKind.STRUCTURED_GRID:
            raise ResourceValidationError("tagged structured field domainRef must be a structured grid")
        values_ref = children["value"]
        values = self._tensor(values_ref, "tagged structured field values")
        self._require_numeric(values, "tagged structured field values")
        basis = children.get("basis")
        raw_components = value.get("components")
        components: tuple[str, ...] | None = None
        if raw_components is not None:
            if not isinstance(raw_components, (list, tuple)) or not raw_components or any(
                not isinstance(component, str) or not component
                for component in raw_components
            ):
                raise ResourceValidationError(
                    "tagged structured field components must be non-empty strings"
                )
            components = tuple(raw_components)
            if values.ndim == 0 or values.shape[-1] != len(components):
                raise ResourceValidationError(
                    "tagged structured field values trailing dimension must match components"
                )
        domain_node = self._node(domain_ref)
        if not isinstance(domain_node, StructuredGridResource):
            raise ResourceValidationError("tagged structured field domainRef is invalid")
        if tuple(values.shape[: len(domain_node.shape)]) != domain_node.shape:
            raise ResourceValidationError("tagged structured field values do not match its domain shape")
        metadata = self._ingest(
            {"wireKind": _STRUCTURED_FIELD_TAG},
            memo,
            active,
            created,
            copy_arrays,
        )
        return self._add_node(
            FieldResource(
                domain_ref,
                location,
                quantity_kind,
                unit,
                values_ref,
                basis,
                components,
                metadata,
                wire,
            ),
            created,
        )

    def _ingest_tagged_structured_bundle(
        self,
        value: Mapping[Any, Any],
        memo: dict[int, ResourceRef],
        active: set[int],
        created: list[str],
        copy_arrays: bool,
    ) -> ResourceRef:
        if not isinstance(value.get("members"), Mapping):
            raise ResourceValidationError("tagged structured bundle must declare members")
        wire = self._ingest_plain_mapping(value, memo, active, created, copy_arrays)
        wire_node = self._require_mapping(wire, "tagged structured bundle")
        members = dict(wire_node.items)["members"]
        self._require_mapping(members, "tagged structured bundle members")
        metadata = self._ingest(
            {"wireKind": _RAY_PATH_BUNDLE_TAG},
            memo,
            active,
            created,
            copy_arrays,
        )
        return self._add_node(
            StructuredBundleResource(_RAY_PATH_BUNDLE_TAG, members, metadata, wire),
            created,
        )

    def _ingest_structured_grid(
        self,
        value: StructuredGrid,
        memo: dict[int, ResourceRef],
        active: set[int],
        created: list[str],
        copy_arrays: bool,
    ) -> ResourceRef:
        axes = tuple(
            self._ingest(axis, memo, active, created, copy_arrays) for axis in value.axes
        )
        for index, (axis_ref, size) in enumerate(zip(axes, value.shape, strict=True)):
            axis = self._tensor(axis_ref, f"structured grid axis {index}")
            if axis.ndim != 1 or axis.shape[0] != size:
                raise ResourceValidationError(
                    f"structured grid axis {index} must have shape ({size},)"
                )
            self._require_numeric(axis, f"structured grid axis {index}")
            if not np.all(np.isfinite(axis)):
                raise ResourceValidationError(
                    f"structured grid axis {index} must contain finite coordinates"
                )
            differences = np.diff(axis)
            if differences.size and not (
                np.all(differences > 0) or np.all(differences < 0)
            ):
                raise ResourceValidationError(
                    f"structured grid axis {index} must be strictly monotonic"
                )
        metadata = self._ingest(value.metadata, memo, active, created, copy_arrays)
        self._require_mapping(metadata, "structured grid metadata")
        return self._add_node(
            StructuredGridResource(
                value.shape,
                axes,
                value.unit,
                value.identity,
                metadata,
            ),
            created,
        )

    def _ingest_unstructured_mesh(
        self,
        value: UnstructuredMesh,
        memo: dict[int, ResourceRef],
        active: set[int],
        created: list[str],
        copy_arrays: bool,
    ) -> ResourceRef:
        points_ref = self._ingest(value.points, memo, active, created, copy_arrays)
        cells_ref = self._ingest(value.cells, memo, active, created, copy_arrays)
        metadata = self._ingest(value.metadata, memo, active, created, copy_arrays)
        points = self._tensor(points_ref, "mesh points")
        self._require_numeric(points, "mesh points")
        if points.ndim != 2 or points.shape[1] == 0:
            raise ResourceValidationError("mesh points must have shape [point, coordinate]")
        self._validate_connectivity(cells_ref, points.shape[0])
        self._require_mapping(metadata, "mesh metadata")
        return self._add_node(
            UnstructuredMeshResource(
                points_ref,
                cells_ref,
                value.unit,
                value.identity,
                metadata,
            ),
            created,
        )

    def _ingest_field(
        self,
        value: Field,
        memo: dict[int, ResourceRef],
        active: set[int],
        created: list[str],
        copy_arrays: bool,
    ) -> ResourceRef:
        self._validate_ref(value.domain_ref)
        domain_kind = self.kind(value.domain_ref)
        spatial = {ResourceKind.STRUCTURED_GRID, ResourceKind.UNSTRUCTURED_MESH}
        expected = {
            FieldLocation.PARTICLE: {ResourceKind.PARTICLE_SET},
            FieldLocation.RAY: {ResourceKind.RAY_SET},
        }.get(value.location, spatial)
        if domain_kind not in expected:
            raise ResourceValidationError(
                f"{value.location.value} field cannot reference {domain_kind.value} domain"
            )
        values_ref = self._ingest(value.values, memo, active, created, copy_arrays)
        values = self._tensor(values_ref, "field values")
        self._require_numeric(values, "field values")
        if value.components is not None and (
            values.ndim == 0 or values.shape[-1] != len(value.components)
        ):
            raise ResourceValidationError(
                "field values trailing dimension must match components"
            )
        basis = (
            None
            if value.basis is None
            else self._ingest(value.basis, memo, active, created, copy_arrays)
        )
        metadata = self._ingest(value.metadata, memo, active, created, copy_arrays)
        self._require_mapping(metadata, "field metadata")
        return self._add_node(
            FieldResource(
                value.domain_ref,
                value.location,
                value.quantity_kind,
                value.unit,
                values_ref,
                basis,
                value.components,
                metadata,
            ),
            created,
        )

    def _ingest_particle_set(
        self,
        value: ParticleSet,
        memo: dict[int, ResourceRef],
        active: set[int],
        created: list[str],
        copy_arrays: bool,
    ) -> ResourceRef:
        positions_ref = self._ingest(value.positions, memo, active, created, copy_arrays)
        attributes = self._ingest(value.attributes, memo, active, created, copy_arrays)
        metadata = self._ingest(value.metadata, memo, active, created, copy_arrays)
        positions = self._tensor(positions_ref, "particle positions")
        self._require_numeric(positions, "particle positions")
        if positions.ndim != 2 or positions.shape[1] == 0:
            raise ResourceValidationError(
                "particle positions must have shape [particle, coordinate]"
            )
        self._validate_attributes(attributes, positions.shape[0], "particle")
        self._require_mapping(metadata, "particle metadata")
        return self._add_node(
            ParticleSetResource(
                positions_ref,
                value.unit,
                attributes,
                value.identity,
                metadata,
            ),
            created,
        )

    def _ingest_ray_set(
        self,
        value: RaySet,
        memo: dict[int, ResourceRef],
        active: set[int],
        created: list[str],
        copy_arrays: bool,
    ) -> ResourceRef:
        origins_ref = self._ingest(value.origins, memo, active, created, copy_arrays)
        directions_ref = self._ingest(value.directions, memo, active, created, copy_arrays)
        attributes = self._ingest(value.attributes, memo, active, created, copy_arrays)
        metadata = self._ingest(value.metadata, memo, active, created, copy_arrays)
        origins = self._tensor(origins_ref, "ray origins")
        directions = self._tensor(directions_ref, "ray directions")
        self._require_numeric(origins, "ray origins")
        self._require_numeric(directions, "ray directions")
        if origins.ndim != 2 or origins.shape[1] == 0:
            raise ResourceValidationError("ray origins must have shape [ray, coordinate]")
        if directions.shape != origins.shape:
            raise ResourceValidationError("ray directions must match ray origins shape")
        if np.any(np.linalg.norm(directions, axis=1) == 0):
            raise ResourceValidationError("ray directions cannot be zero")
        self._validate_attributes(attributes, origins.shape[0], "ray")
        self._require_mapping(metadata, "ray metadata")
        return self._add_node(
            RaySetResource(
                origins_ref,
                directions_ref,
                value.unit,
                attributes,
                value.identity,
                metadata,
            ),
            created,
        )

    def _ingest_structured_bundle(
        self,
        value: StructuredBundle,
        memo: dict[int, ResourceRef],
        active: set[int],
        created: list[str],
        copy_arrays: bool,
    ) -> ResourceRef:
        members = self._ingest(value.members, memo, active, created, copy_arrays)
        metadata = self._ingest(value.metadata, memo, active, created, copy_arrays)
        self._require_mapping(members, "structured bundle members")
        self._require_mapping(metadata, "structured bundle metadata")
        return self._add_node(
            StructuredBundleResource(value.bundle_type, members, metadata),
            created,
        )

    def _validate_connectivity(self, ref: ResourceRef, point_count: int) -> None:
        node = self._node(ref)
        if isinstance(node, TensorResource):
            connectivities = (("cells", node.array),)
        elif isinstance(node, MappingResource):
            if not node.items:
                raise ResourceValidationError("mesh cells cannot be empty")
            connectivities = tuple(
                (str(name), self._tensor(child, f"mesh cell block {name!r}"))
                for name, child in node.items
            )
        else:
            raise ResourceValidationError("mesh cells must be a tensor or named tensor mapping")
        for name, connectivity in connectivities:
            if connectivity.ndim != 2 or connectivity.shape[1] == 0:
                raise ResourceValidationError(
                    f"mesh cell block {name!r} must have shape [cell, node]"
                )
            if not np.issubdtype(connectivity.dtype, np.integer):
                raise ResourceValidationError(
                    f"mesh cell block {name!r} must contain integer point indexes"
                )
            if connectivity.size and (
                int(connectivity.min()) < 0 or int(connectivity.max()) >= point_count
            ):
                raise ResourceValidationError(
                    f"mesh cell block {name!r} contains an out-of-range point index"
                )

    def _validate_attributes(self, ref: ResourceRef, count: int, owner: str) -> None:
        node = self._require_mapping(ref, f"{owner} attributes")
        for name, child in node.items:
            values = self._tensor(child, f"{owner} attribute {name!r}")
            if values.ndim == 0 or values.shape[0] != count:
                raise ResourceValidationError(
                    f"{owner} attribute {name!r} must have first dimension {count}"
                )

    def _tensor(self, ref: ResourceRef, name: str) -> np.ndarray[Any, Any]:
        node = self._node(ref)
        if not isinstance(node, TensorResource):
            raise ResourceValidationError(f"{name} must be a tensor resource")
        return node.array

    def _require_mapping(self, ref: ResourceRef, name: str) -> MappingResource:
        node = self._node(ref)
        if not isinstance(node, MappingResource):
            raise ResourceValidationError(f"{name} must be a mapping resource")
        return node

    @staticmethod
    def _require_numeric(array: np.ndarray[Any, Any], name: str) -> None:
        if not np.issubdtype(array.dtype, np.number) or np.issubdtype(array.dtype, np.bool_):
            raise ResourceValidationError(f"{name} must use a numeric dtype")

    def _resource_metadata(self, ref: ResourceRef, **standard: Any) -> Mapping[str, Any]:
        metadata = dict(self._resolve(ref, {}))
        metadata.update(standard)
        return MappingProxyType(metadata)

    def _add_node(self, node: ResourceNode, created: list[str] | None = None) -> ResourceRef:
        for child in self._children(node):
            self._validate_ref(child)
        self._sequence += 1
        resource_id = f"resource-{self._sequence}"
        buffer_lease = (
            BufferStore.acquire_array_lease(
                node.array,
                owner=f"{self.store_id}:{resource_id}",
            )
            if isinstance(node, TensorResource)
            else None
        )
        self._nodes[resource_id] = node
        self._inbound_references[resource_id] = 0
        if buffer_lease is not None:
            self._buffer_leases[resource_id] = buffer_lease
        for child in self._children(node):
            self._inbound_references[child.resource_id] += 1
        if created is not None:
            created.append(resource_id)
        return ResourceRef(self.store_id, resource_id)

    def _resolve(self, ref: ResourceRef, memo: dict[str, Any]) -> Any:
        if ref.resource_id in memo:
            return memo[ref.resource_id]
        node = self._node(ref)
        if isinstance(node, TensorResource):
            memo[ref.resource_id] = node.array
            return node.array
        if isinstance(node, StructuredGridResource):
            if node.wire is not None:
                value = self._resolve(node.wire, memo)
                memo[ref.resource_id] = value
                return value
            value = StructuredGrid(
                node.shape,
                tuple(self._resolve(axis, memo) for axis in node.axes),
                node.unit,
                node.identity,
                self._resolve(node.metadata, memo),
            )
            memo[ref.resource_id] = value
            return value
        if isinstance(node, UnstructuredMeshResource):
            value = UnstructuredMesh(
                self._resolve(node.points, memo),
                self._resolve(node.cells, memo),
                node.unit,
                node.identity,
                self._resolve(node.metadata, memo),
            )
            memo[ref.resource_id] = value
            return value
        if isinstance(node, FieldResource):
            if node.wire is not None:
                value = self._resolve(node.wire, memo)
                memo[ref.resource_id] = value
                return value
            value = Field(
                node.domain_ref,
                node.location,
                node.quantity_kind,
                node.unit,
                self._resolve(node.values, memo),
                None if node.basis is None else self._resolve(node.basis, memo),
                node.components,
                self._resolve(node.metadata, memo),
            )
            memo[ref.resource_id] = value
            return value
        if isinstance(node, ParticleSetResource):
            value = ParticleSet(
                self._resolve(node.positions, memo),
                node.unit,
                self._resolve(node.attributes, memo),
                node.identity,
                self._resolve(node.metadata, memo),
            )
            memo[ref.resource_id] = value
            return value
        if isinstance(node, RaySetResource):
            value = RaySet(
                self._resolve(node.origins, memo),
                self._resolve(node.directions, memo),
                node.unit,
                self._resolve(node.attributes, memo),
                node.identity,
                self._resolve(node.metadata, memo),
            )
            memo[ref.resource_id] = value
            return value
        if isinstance(node, StructuredBundleResource):
            if node.wire is not None:
                value = self._resolve(node.wire, memo)
                memo[ref.resource_id] = value
                return value
            value = StructuredBundle(
                node.bundle_type,
                self._resolve(node.members, memo),
                self._resolve(node.metadata, memo),
            )
            memo[ref.resource_id] = value
            return value
        if isinstance(node, MappingResource):
            resolved = {
                key: self._resolve(child, memo)
                for key, child in node.items
            }
            value = MappingProxyType(resolved)
            memo[ref.resource_id] = value
            return value
        if isinstance(node, SequenceResource):
            value = tuple(self._resolve(child, memo) for child in node.items)
            memo[ref.resource_id] = value
            return value
        value = copy.deepcopy(node.value)
        memo[ref.resource_id] = value
        return value

    def _materialize_mutable(
        self,
        ref: ResourceRef,
        memo: dict[str, Any],
        copy_arrays: bool,
    ) -> Any:
        if ref.resource_id in memo:
            return memo[ref.resource_id]
        node = self._node(ref)
        if isinstance(node, TensorResource):
            value = np.array(node.array, copy=True) if copy_arrays else node.array
            memo[ref.resource_id] = value
            return value
        if isinstance(node, StructuredGridResource):
            if node.wire is not None:
                value = self._materialize_mutable(node.wire, memo, copy_arrays)
                memo[ref.resource_id] = value
                return value
            value = StructuredGrid(
                node.shape,
                tuple(
                    self._materialize_mutable(axis, memo, copy_arrays)
                    for axis in node.axes
                ),
                node.unit,
                node.identity,
                self._materialize_mutable(node.metadata, memo, copy_arrays),
            )
            memo[ref.resource_id] = value
            return value
        if isinstance(node, UnstructuredMeshResource):
            value = UnstructuredMesh(
                self._materialize_mutable(node.points, memo, copy_arrays),
                self._materialize_mutable(node.cells, memo, copy_arrays),
                node.unit,
                node.identity,
                self._materialize_mutable(node.metadata, memo, copy_arrays),
            )
            memo[ref.resource_id] = value
            return value
        if isinstance(node, FieldResource):
            if node.wire is not None:
                value = self._materialize_mutable(node.wire, memo, copy_arrays)
                memo[ref.resource_id] = value
                return value
            value = Field(
                node.domain_ref,
                node.location,
                node.quantity_kind,
                node.unit,
                self._materialize_mutable(node.values, memo, copy_arrays),
                None
                if node.basis is None
                else self._materialize_mutable(node.basis, memo, copy_arrays),
                node.components,
                self._materialize_mutable(node.metadata, memo, copy_arrays),
            )
            memo[ref.resource_id] = value
            return value
        if isinstance(node, ParticleSetResource):
            value = ParticleSet(
                self._materialize_mutable(node.positions, memo, copy_arrays),
                node.unit,
                self._materialize_mutable(node.attributes, memo, copy_arrays),
                node.identity,
                self._materialize_mutable(node.metadata, memo, copy_arrays),
            )
            memo[ref.resource_id] = value
            return value
        if isinstance(node, RaySetResource):
            value = RaySet(
                self._materialize_mutable(node.origins, memo, copy_arrays),
                self._materialize_mutable(node.directions, memo, copy_arrays),
                node.unit,
                self._materialize_mutable(node.attributes, memo, copy_arrays),
                node.identity,
                self._materialize_mutable(node.metadata, memo, copy_arrays),
            )
            memo[ref.resource_id] = value
            return value
        if isinstance(node, StructuredBundleResource):
            if node.wire is not None:
                value = self._materialize_mutable(node.wire, memo, copy_arrays)
                memo[ref.resource_id] = value
                return value
            value = StructuredBundle(
                node.bundle_type,
                self._materialize_mutable(node.members, memo, copy_arrays),
                self._materialize_mutable(node.metadata, memo, copy_arrays),
            )
            memo[ref.resource_id] = value
            return value
        if isinstance(node, MappingResource):
            value: dict[Any, Any] = {}
            memo[ref.resource_id] = value
            value.update(
                (key, self._materialize_mutable(child, memo, copy_arrays))
                for key, child in node.items
            )
            return value
        if isinstance(node, SequenceResource):
            values = [self._materialize_mutable(child, memo, copy_arrays) for child in node.items]
            value = tuple(values) if node.sequence_type == "tuple" else values
            memo[ref.resource_id] = value
            return value
        value = copy.deepcopy(node.value)
        memo[ref.resource_id] = value
        return value

    def _rewrite(
        self,
        ref: ResourceRef,
        path: StatePath,
        offset: int,
        replacement: ResourceRef | object,
    ) -> ResourceRef | object:
        if offset == len(path):
            return replacement
        node = self._node(ref)
        token = path[offset]
        if isinstance(node, MappingResource):
            index = next((i for i, (key, _) in enumerate(node.items) if key == token), None)
            if index is None:
                if offset != len(path) - 1 or replacement is _DELETE:
                    raise KeyError(path[: offset + 1])
                items = (*node.items, (copy.deepcopy(token), replacement))
            else:
                child = self._rewrite(node.items[index][1], path, offset + 1, replacement)
                if child is _DELETE:
                    items = node.items[:index] + node.items[index + 1 :]
                else:
                    items = (
                        node.items[:index]
                        + ((node.items[index][0], child),)
                        + node.items[index + 1 :]
                    )
            return self._add_node(MappingResource(tuple(items)))
        if isinstance(node, SequenceResource):
            if not isinstance(token, int) or isinstance(token, bool):
                raise TypeError("sequence state paths require integer indexes")
            index = token if token >= 0 else len(node.items) + token
            if not 0 <= index < len(node.items):
                raise IndexError(token)
            child = self._rewrite(node.items[index], path, offset + 1, replacement)
            if child is _DELETE:
                items = node.items[:index] + node.items[index + 1 :]
            else:
                items = node.items[:index] + (child,) + node.items[index + 1 :]
            return self._add_node(SequenceResource(items, node.sequence_type))
        raise TypeError(f"cannot traverse {node.kind.value} resource at {path[:offset]!r}")

    def _collect(self, resource_id: str) -> None:
        if resource_id not in self._nodes:
            return
        if self._lease_counts.get(resource_id, 0) or self._inbound_references[resource_id]:
            return
        self._release_buffer_lease(resource_id)
        node = self._nodes.pop(resource_id)
        del self._inbound_references[resource_id]
        for child in self._children(node):
            child_id = child.resource_id
            self._inbound_references[child_id] -= 1
            self._collect(child_id)

    def _rollback_created(self, created: list[str]) -> None:
        for resource_id in reversed(created):
            self._release_buffer_lease(resource_id)
            node = self._nodes.pop(resource_id, None)
            self._inbound_references.pop(resource_id, None)
            if node is None:
                continue
            for child in self._children(node):
                if child.resource_id in self._inbound_references:
                    self._inbound_references[child.resource_id] -= 1

    def _release_buffer_lease(self, resource_id: str) -> None:
        lease = self._buffer_leases.pop(resource_id, None)
        if lease is not None:
            BufferStore.release_array_lease(lease)

    def _node(self, ref: ResourceRef) -> ResourceNode:
        self._validate_ref(ref)
        return self._nodes[ref.resource_id]

    def _validate_ref(self, ref: ResourceRef) -> None:
        self._ensure_open()
        if not isinstance(ref, ResourceRef) or ref.store_id != self.store_id:
            raise ResourceScopeError("resource reference belongs to another store")
        if ref.resource_id not in self._nodes:
            raise ResourceNotFoundError(f"resource {ref.resource_id!r} is not live")

    def _ensure_open(self) -> None:
        if self._closed:
            raise ResourceNotFoundError("resource store is closed")

    @staticmethod
    def _children(node: ResourceNode) -> tuple[ResourceRef, ...]:
        if isinstance(node, MappingResource):
            return tuple(child for _, child in node.items)
        if isinstance(node, SequenceResource):
            return node.items
        if isinstance(node, StructuredGridResource):
            return (
                *node.axes,
                node.metadata,
                *((node.wire,) if node.wire is not None else ()),
            )
        if isinstance(node, UnstructuredMeshResource):
            return (node.points, node.cells, node.metadata)
        if isinstance(node, FieldResource):
            return (
                node.domain_ref,
                node.values,
                *((node.basis,) if node.basis is not None else ()),
                node.metadata,
                *((node.wire,) if node.wire is not None else ()),
            )
        if isinstance(node, ParticleSetResource):
            return (node.positions, node.attributes, node.metadata)
        if isinstance(node, RaySetResource):
            return (node.origins, node.directions, node.attributes, node.metadata)
        if isinstance(node, StructuredBundleResource):
            return (
                node.members,
                node.metadata,
                *((node.wire,) if node.wire is not None else ()),
            )
        return ()
