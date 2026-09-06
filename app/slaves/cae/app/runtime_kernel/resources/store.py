from __future__ import annotations

import copy
import threading
import uuid
from collections.abc import Hashable, Mapping, Sequence
from types import MappingProxyType
from typing import Any

import numpy as np

from app.runtime_kernel.resources.buffers import BufferLease, BufferStore
from app.runtime_kernel.resources.nodes import (
    FieldResource,
    MappingResource,
    ParticleSetResource,
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
    SequenceResource,
    StructuredBundleResource,
    StructuredGridResource,
    TensorResource,
    UnstructuredMeshResource,
)
from app.runtime_kernel.resources.value_io import (
    ingest_value,
    materialize_value,
    resolve_value,
)

StatePath = tuple[Hashable, ...]
_DELETE = object()


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
                    ingest_value(self, value, memo, active, created, copy_arrays) for value in values
                )
            except BaseException:
                self._rollback_created(created)
                raise

    def resolve(self, ref: ResourceRef) -> Any:
        """Return an immutable Store-local view, retaining legacy field references."""
        with self._lock:
            self._validate_ref(ref)
            return resolve_value(self, ref, {})

    def materialize(
        self,
        ref: ResourceRef,
        *,
        mutable: bool = True,
        copy_arrays: bool = True,
    ) -> Any:
        """Export self-contained solver values without runtime resource references."""
        with self._lock:
            self._validate_ref(ref)
            if not mutable:
                return resolve_value(self, ref, {}, detached=True)
            return materialize_value(self, ref, {}, copy_arrays)

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
                basis = None if node.basis is None else resolve_value(self, node.basis, {})
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
        metadata = dict(resolve_value(self, ref, {}))
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
