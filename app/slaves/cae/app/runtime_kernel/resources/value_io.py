"""Translate solver values to and from a run's resource graph."""

from __future__ import annotations

import copy
from collections.abc import Mapping
from types import MappingProxyType
from typing import TYPE_CHECKING, Any

import numpy as np

from app.runtime_kernel.api.values import (
    BundleValue,
    FieldLocation,
    FieldValue,
    ParticleSetValue,
    RaySetValue,
    StructuredGridValue,
    UnstructuredMeshValue,
)
from app.runtime_kernel.compat.payloads import (
    Field,
    _ingest_tagged_structured_bundle,
    _ingest_tagged_structured_field,
    _ingest_tagged_structured_grid,
)
from app.runtime_kernel.resources.nodes import (
    CyclicResourceError,
    FieldResource,
    MappingResource,
    ParticleSetResource,
    RaySetResource,
    ResourceKind,
    ResourceRef,
    ResourceValidationError,
    ScalarResource,
    SequenceResource,
    StructuredBundleResource,
    StructuredGridResource,
    TensorResource,
    UnstructuredMeshResource,
)

if TYPE_CHECKING:
    from app.runtime_kernel.resources.store import ResourceStore

_STRUCTURED_GRID_TAG = "caemble.structured-grid/v1"
_STRUCTURED_FIELD_TAG = "caemble.structured-field/v1"
_RAY_PATH_BUNDLE_TAG = "caemble.ray-path-bundle/v1"


def ingest_value(
    store: ResourceStore,
    value: Any,
    memo: dict[int, ResourceRef],
    active: set[int],
    created: list[str],
    copy_arrays: bool,
) -> ResourceRef:
    if isinstance(value, ResourceRef):
        store._validate_ref(value)
        return value

    tracked = isinstance(
        value,
        (
            Mapping,
            list,
            tuple,
            np.ndarray,
            StructuredGridValue,
            UnstructuredMeshValue,
            Field,
            FieldValue,
            ParticleSetValue,
            RaySetValue,
            BundleValue,
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
            ref = store._add_node(TensorResource(array), created)
        elif isinstance(value, StructuredGridValue):
            ref = _ingest_structured_grid(store, value, memo, active, created, copy_arrays)
        elif isinstance(value, UnstructuredMeshValue):
            ref = _ingest_unstructured_mesh(store, value, memo, active, created, copy_arrays)
        elif isinstance(value, (Field, FieldValue)):
            ref = _ingest_field(store, value, memo, active, created, copy_arrays)
        elif isinstance(value, ParticleSetValue):
            ref = _ingest_particle_set(store, value, memo, active, created, copy_arrays)
        elif isinstance(value, RaySetValue):
            ref = _ingest_ray_set(store, value, memo, active, created, copy_arrays)
        elif isinstance(value, BundleValue):
            ref = _ingest_structured_bundle(store, value, memo, active, created, copy_arrays)
        elif isinstance(value, Mapping) and value.get("kind") == _STRUCTURED_GRID_TAG:
            ref = _ingest_tagged_structured_grid(store, value, memo, active, created, copy_arrays)
        elif isinstance(value, Mapping) and value.get("kind") == _STRUCTURED_FIELD_TAG:
            ref = _ingest_tagged_structured_field(store, value, memo, active, created, copy_arrays)
        elif isinstance(value, Mapping) and value.get("kind") == _RAY_PATH_BUNDLE_TAG:
            ref = _ingest_tagged_structured_bundle(store, value, memo, active, created, copy_arrays)
        elif isinstance(value, Mapping):
            ref = ingest_mapping(store, value, memo, active, created, copy_arrays)
        elif isinstance(value, (list, tuple)):
            items = tuple(
                ingest_value(store, item, memo, active, created, copy_arrays) for item in value
            )
            ref = store._add_node(
                SequenceResource(items, "tuple" if isinstance(value, tuple) else "list"),
                created,
            )
        else:
            ref = store._add_node(ScalarResource(copy.deepcopy(value)), created)
    finally:
        if tracked:
            active.discard(value_id)

    if tracked:
        memo[value_id] = ref
    return ref


def ingest_mapping(
    store: ResourceStore,
    value: Mapping[Any, Any],
    memo: dict[int, ResourceRef],
    active: set[int],
    created: list[str],
    copy_arrays: bool,
) -> ResourceRef:
    return store._add_node(
        MappingResource(
            tuple(
                (
                    copy.deepcopy(key),
                    ingest_value(store, item, memo, active, created, copy_arrays),
                )
                for key, item in value.items()
            )
        ),
        created,
    )


def _ingest_structured_grid(
    store: ResourceStore,
    value: StructuredGridValue,
    memo: dict[int, ResourceRef],
    active: set[int],
    created: list[str],
    copy_arrays: bool,
) -> ResourceRef:
    axes = tuple(
        ingest_value(store, axis, memo, active, created, copy_arrays) for axis in value.axes
    )
    for index, (axis_ref, size) in enumerate(zip(axes, value.shape, strict=True)):
        axis = store._tensor(axis_ref, f"structured grid axis {index}")
        if axis.ndim != 1 or axis.shape[0] != size:
            raise ResourceValidationError(
                f"structured grid axis {index} must have shape ({size},)"
            )
        store._require_numeric(axis, f"structured grid axis {index}")
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
    metadata = ingest_value(store, value.metadata, memo, active, created, copy_arrays)
    store._require_mapping(metadata, "structured grid metadata")
    return store._add_node(
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
    store: ResourceStore,
    value: UnstructuredMeshValue,
    memo: dict[int, ResourceRef],
    active: set[int],
    created: list[str],
    copy_arrays: bool,
) -> ResourceRef:
    points_ref = ingest_value(store, value.points, memo, active, created, copy_arrays)
    cells_ref = ingest_value(store, value.cells, memo, active, created, copy_arrays)
    metadata = ingest_value(store, value.metadata, memo, active, created, copy_arrays)
    points = store._tensor(points_ref, "mesh points")
    store._require_numeric(points, "mesh points")
    if points.ndim != 2 or points.shape[1] == 0:
        raise ResourceValidationError("mesh points must have shape [point, coordinate]")
    _validate_connectivity(store, cells_ref, points.shape[0])
    store._require_mapping(metadata, "mesh metadata")
    return store._add_node(
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
    store: ResourceStore,
    value: Field | FieldValue,
    memo: dict[int, ResourceRef],
    active: set[int],
    created: list[str],
    copy_arrays: bool,
) -> ResourceRef:
    domain = value.domain if isinstance(value, FieldValue) else value.domain_ref
    domain_ref = ingest_value(store, domain, memo, active, created, copy_arrays)
    domain_kind = store.kind(domain_ref)
    spatial = {ResourceKind.STRUCTURED_GRID, ResourceKind.UNSTRUCTURED_MESH}
    expected = {
        FieldLocation.PARTICLE: {ResourceKind.PARTICLE_SET},
        FieldLocation.RAY: {ResourceKind.RAY_SET},
    }.get(value.location, spatial)
    if domain_kind not in expected:
        raise ResourceValidationError(
            f"{value.location.value} field cannot reference {domain_kind.value} domain"
        )
    values_ref = ingest_value(store, value.values, memo, active, created, copy_arrays)
    values = store._tensor(values_ref, "field values")
    store._require_numeric(values, "field values")
    if value.components is not None and (
        values.ndim == 0 or values.shape[-1] != len(value.components)
    ):
        raise ResourceValidationError(
            "field values trailing dimension must match components"
        )
    basis = (
        None
        if value.basis is None
        else ingest_value(store, value.basis, memo, active, created, copy_arrays)
    )
    metadata = ingest_value(store, value.metadata, memo, active, created, copy_arrays)
    store._require_mapping(metadata, "field metadata")
    return store._add_node(
        FieldResource(
            domain_ref,
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
    store: ResourceStore,
    value: ParticleSetValue,
    memo: dict[int, ResourceRef],
    active: set[int],
    created: list[str],
    copy_arrays: bool,
) -> ResourceRef:
    positions_ref = ingest_value(store, value.positions, memo, active, created, copy_arrays)
    attributes = ingest_value(store, value.attributes, memo, active, created, copy_arrays)
    metadata = ingest_value(store, value.metadata, memo, active, created, copy_arrays)
    positions = store._tensor(positions_ref, "particle positions")
    store._require_numeric(positions, "particle positions")
    if positions.ndim != 2 or positions.shape[1] == 0:
        raise ResourceValidationError(
            "particle positions must have shape [particle, coordinate]"
        )
    _validate_attributes(store, attributes, positions.shape[0], "particle")
    store._require_mapping(metadata, "particle metadata")
    return store._add_node(
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
    store: ResourceStore,
    value: RaySetValue,
    memo: dict[int, ResourceRef],
    active: set[int],
    created: list[str],
    copy_arrays: bool,
) -> ResourceRef:
    origins_ref = ingest_value(store, value.origins, memo, active, created, copy_arrays)
    directions_ref = ingest_value(store, value.directions, memo, active, created, copy_arrays)
    attributes = ingest_value(store, value.attributes, memo, active, created, copy_arrays)
    metadata = ingest_value(store, value.metadata, memo, active, created, copy_arrays)
    origins = store._tensor(origins_ref, "ray origins")
    directions = store._tensor(directions_ref, "ray directions")
    store._require_numeric(origins, "ray origins")
    store._require_numeric(directions, "ray directions")
    if origins.ndim != 2 or origins.shape[1] == 0:
        raise ResourceValidationError("ray origins must have shape [ray, coordinate]")
    if directions.shape != origins.shape:
        raise ResourceValidationError("ray directions must match ray origins shape")
    if np.any(np.linalg.norm(directions, axis=1) == 0):
        raise ResourceValidationError("ray directions cannot be zero")
    _validate_attributes(store, attributes, origins.shape[0], "ray")
    store._require_mapping(metadata, "ray metadata")
    return store._add_node(
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
    store: ResourceStore,
    value: BundleValue,
    memo: dict[int, ResourceRef],
    active: set[int],
    created: list[str],
    copy_arrays: bool,
) -> ResourceRef:
    members = ingest_value(store, value.members, memo, active, created, copy_arrays)
    metadata = ingest_value(store, value.metadata, memo, active, created, copy_arrays)
    store._require_mapping(members, "structured bundle members")
    store._require_mapping(metadata, "structured bundle metadata")
    return store._add_node(
        StructuredBundleResource(value.bundle_type, members, metadata),
        created,
    )


def _validate_connectivity(store: ResourceStore, ref: ResourceRef, point_count: int) -> None:
    node = store._node(ref)
    if isinstance(node, TensorResource):
        connectivities = (("cells", node.array),)
    elif isinstance(node, MappingResource):
        if not node.items:
            raise ResourceValidationError("mesh cells cannot be empty")
        connectivities = tuple(
            (str(name), store._tensor(child, f"mesh cell block {name!r}"))
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


def _validate_attributes(store: ResourceStore, ref: ResourceRef, count: int, owner: str) -> None:
    node = store._require_mapping(ref, f"{owner} attributes")
    for name, child in node.items:
        values = store._tensor(child, f"{owner} attribute {name!r}")
        if values.ndim == 0 or values.shape[0] != count:
            raise ResourceValidationError(
                f"{owner} attribute {name!r} must have first dimension {count}"
            )


def resolve_value(
    store: ResourceStore,
    ref: ResourceRef,
    memo: dict[str, Any],
    detached: bool = False,
) -> Any:
    if ref.resource_id in memo:
        return memo[ref.resource_id]
    node = store._node(ref)
    if isinstance(node, TensorResource):
        memo[ref.resource_id] = node.array
        return node.array
    if isinstance(node, StructuredGridResource):
        if node.wire is not None:
            value = resolve_value(store, node.wire, memo, detached)
            memo[ref.resource_id] = value
            return value
        value = StructuredGridValue(
            node.shape,
            tuple(resolve_value(store, axis, memo, detached) for axis in node.axes),
            node.unit,
            node.identity,
            resolve_value(store, node.metadata, memo, detached),
        )
        memo[ref.resource_id] = value
        return value
    if isinstance(node, UnstructuredMeshResource):
        value = UnstructuredMeshValue(
            resolve_value(store, node.points, memo, detached),
            resolve_value(store, node.cells, memo, detached),
            node.unit,
            node.identity,
            resolve_value(store, node.metadata, memo, detached),
        )
        memo[ref.resource_id] = value
        return value
    if isinstance(node, FieldResource):
        if node.wire is not None:
            value = resolve_value(store, node.wire, memo, detached)
            memo[ref.resource_id] = value
            return value
        field_type = FieldValue if detached else Field
        value = field_type(
            resolve_value(store, node.domain_ref, memo, detached)
            if detached
            else node.domain_ref,
            node.location,
            node.quantity_kind,
            node.unit,
            resolve_value(store, node.values, memo, detached),
            None if node.basis is None else resolve_value(store, node.basis, memo, detached),
            node.components,
            resolve_value(store, node.metadata, memo, detached),
        )
        memo[ref.resource_id] = value
        return value
    if isinstance(node, ParticleSetResource):
        value = ParticleSetValue(
            resolve_value(store, node.positions, memo, detached),
            node.unit,
            resolve_value(store, node.attributes, memo, detached),
            node.identity,
            resolve_value(store, node.metadata, memo, detached),
        )
        memo[ref.resource_id] = value
        return value
    if isinstance(node, RaySetResource):
        value = RaySetValue(
            resolve_value(store, node.origins, memo, detached),
            resolve_value(store, node.directions, memo, detached),
            node.unit,
            resolve_value(store, node.attributes, memo, detached),
            node.identity,
            resolve_value(store, node.metadata, memo, detached),
        )
        memo[ref.resource_id] = value
        return value
    if isinstance(node, StructuredBundleResource):
        if node.wire is not None:
            value = resolve_value(store, node.wire, memo, detached)
            memo[ref.resource_id] = value
            return value
        value = BundleValue(
            node.bundle_type,
            resolve_value(store, node.members, memo, detached),
            resolve_value(store, node.metadata, memo, detached),
        )
        memo[ref.resource_id] = value
        return value
    if isinstance(node, MappingResource):
        resolved = {
            key: resolve_value(store, child, memo, detached)
            for key, child in node.items
        }
        value = MappingProxyType(resolved)
        memo[ref.resource_id] = value
        return value
    if isinstance(node, SequenceResource):
        value = tuple(resolve_value(store, child, memo, detached) for child in node.items)
        memo[ref.resource_id] = value
        return value
    value = copy.deepcopy(node.value)
    memo[ref.resource_id] = value
    return value


def materialize_value(
    store: ResourceStore,
    ref: ResourceRef,
    memo: dict[str, Any],
    copy_arrays: bool,
) -> Any:
    if ref.resource_id in memo:
        return memo[ref.resource_id]
    node = store._node(ref)
    if isinstance(node, TensorResource):
        value = np.array(node.array, copy=True) if copy_arrays else node.array
        memo[ref.resource_id] = value
        return value
    if isinstance(node, StructuredGridResource):
        if node.wire is not None:
            value = materialize_value(store, node.wire, memo, copy_arrays)
            memo[ref.resource_id] = value
            return value
        value = StructuredGridValue(
            node.shape,
            tuple(
                materialize_value(store, axis, memo, copy_arrays)
                for axis in node.axes
            ),
            node.unit,
            node.identity,
            materialize_value(store, node.metadata, memo, copy_arrays),
        )
        memo[ref.resource_id] = value
        return value
    if isinstance(node, UnstructuredMeshResource):
        value = UnstructuredMeshValue(
            materialize_value(store, node.points, memo, copy_arrays),
            materialize_value(store, node.cells, memo, copy_arrays),
            node.unit,
            node.identity,
            materialize_value(store, node.metadata, memo, copy_arrays),
        )
        memo[ref.resource_id] = value
        return value
    if isinstance(node, FieldResource):
        if node.wire is not None:
            value = materialize_value(store, node.wire, memo, copy_arrays)
            memo[ref.resource_id] = value
            return value
        value = FieldValue(
            materialize_value(store, node.domain_ref, memo, copy_arrays),
            node.location,
            node.quantity_kind,
            node.unit,
            materialize_value(store, node.values, memo, copy_arrays),
            None
            if node.basis is None
            else materialize_value(store, node.basis, memo, copy_arrays),
            node.components,
            materialize_value(store, node.metadata, memo, copy_arrays),
        )
        memo[ref.resource_id] = value
        return value
    if isinstance(node, ParticleSetResource):
        value = ParticleSetValue(
            materialize_value(store, node.positions, memo, copy_arrays),
            node.unit,
            materialize_value(store, node.attributes, memo, copy_arrays),
            node.identity,
            materialize_value(store, node.metadata, memo, copy_arrays),
        )
        memo[ref.resource_id] = value
        return value
    if isinstance(node, RaySetResource):
        value = RaySetValue(
            materialize_value(store, node.origins, memo, copy_arrays),
            materialize_value(store, node.directions, memo, copy_arrays),
            node.unit,
            materialize_value(store, node.attributes, memo, copy_arrays),
            node.identity,
            materialize_value(store, node.metadata, memo, copy_arrays),
        )
        memo[ref.resource_id] = value
        return value
    if isinstance(node, StructuredBundleResource):
        if node.wire is not None:
            value = materialize_value(store, node.wire, memo, copy_arrays)
            memo[ref.resource_id] = value
            return value
        value = BundleValue(
            node.bundle_type,
            materialize_value(store, node.members, memo, copy_arrays),
            materialize_value(store, node.metadata, memo, copy_arrays),
        )
        memo[ref.resource_id] = value
        return value
    if isinstance(node, MappingResource):
        value: dict[Any, Any] = {}
        memo[ref.resource_id] = value
        value.update(
            (key, materialize_value(store, child, memo, copy_arrays))
            for key, child in node.items
        )
        return value
    if isinstance(node, SequenceResource):
        values = [materialize_value(store, child, memo, copy_arrays) for child in node.items]
        value = tuple(values) if node.sequence_type == "tuple" else values
        memo[ref.resource_id] = value
        return value
    value = copy.deepcopy(node.value)
    memo[ref.resource_id] = value
    return value
