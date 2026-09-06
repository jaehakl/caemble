"""Legacy Field constructors and tagged mapping payload conversion."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field as dataclass_field
from typing import TYPE_CHECKING, Any

import numpy as np

from app.runtime_kernel.api.values import FieldLocation, _validate_metadata, _validate_unit

if TYPE_CHECKING:
    from app.runtime_kernel.resources.nodes import ResourceRef


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
        from app.runtime_kernel.resources.nodes import ResourceRef

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


_STRUCTURED_GRID_TAG = "caemble.structured-grid/v1"
_STRUCTURED_FIELD_TAG = "caemble.structured-field/v1"
_RAY_PATH_BUNDLE_TAG = "caemble.ray-path-bundle/v1"


def _ingest_tagged_structured_grid(
    store,
    value: Mapping[Any, Any],
    memo: dict[int, ResourceRef],
    active: set[int],
    created: list[str],
    copy_arrays: bool,
) -> ResourceRef:
    from app.runtime_kernel.resources.nodes import (
        ResourceValidationError,
        StructuredGridResource,
    )
    from app.runtime_kernel.resources.value_io import ingest_mapping, ingest_value

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
        axes.append(ingest_value(store, ticks, memo, active, created, copy_arrays))
    metadata = ingest_value(
        store,
        {"wireKind": _STRUCTURED_GRID_TAG},
        memo,
        active,
        created,
        copy_arrays,
    )
    wire = ingest_mapping(store, value, memo, active, created, copy_arrays)
    return store._add_node(
        StructuredGridResource(shape, tuple(axes), unit, identity, metadata, wire),
        created,
    )


def _ingest_tagged_structured_field(
    store,
    value: Mapping[Any, Any],
    memo: dict[int, ResourceRef],
    active: set[int],
    created: list[str],
    copy_arrays: bool,
) -> ResourceRef:
    from app.runtime_kernel.resources.nodes import (
        FieldResource,
        ResourceKind,
        ResourceValidationError,
        StructuredGridResource,
    )
    from app.runtime_kernel.resources.value_io import ingest_mapping, ingest_value

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

    wire = ingest_mapping(store, value, memo, active, created, copy_arrays)
    wire_node = store._require_mapping(wire, "tagged structured field")
    children = dict(wire_node.items)
    domain_ref = children["domainRef"]
    if store.kind(domain_ref) is not ResourceKind.STRUCTURED_GRID:
        raise ResourceValidationError("tagged structured field domainRef must be a structured grid")
    values_ref = children["value"]
    values = store._tensor(values_ref, "tagged structured field values")
    store._require_numeric(values, "tagged structured field values")
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
    domain_node = store._node(domain_ref)
    if not isinstance(domain_node, StructuredGridResource):
        raise ResourceValidationError("tagged structured field domainRef is invalid")
    if tuple(values.shape[: len(domain_node.shape)]) != domain_node.shape:
        raise ResourceValidationError("tagged structured field values do not match its domain shape")
    metadata = ingest_value(
        store,
        {"wireKind": _STRUCTURED_FIELD_TAG},
        memo,
        active,
        created,
        copy_arrays,
    )
    return store._add_node(
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
    store,
    value: Mapping[Any, Any],
    memo: dict[int, ResourceRef],
    active: set[int],
    created: list[str],
    copy_arrays: bool,
) -> ResourceRef:
    from app.runtime_kernel.resources.nodes import (
        ResourceValidationError,
        StructuredBundleResource,
    )
    from app.runtime_kernel.resources.value_io import ingest_mapping, ingest_value

    if not isinstance(value.get("members"), Mapping):
        raise ResourceValidationError("tagged structured bundle must declare members")
    wire = ingest_mapping(store, value, memo, active, created, copy_arrays)
    wire_node = store._require_mapping(wire, "tagged structured bundle")
    members = dict(wire_node.items)["members"]
    store._require_mapping(members, "tagged structured bundle members")
    metadata = ingest_value(
        store,
        {"wireKind": _RAY_PATH_BUNDLE_TAG},
        memo,
        active,
        created,
        copy_arrays,
    )
    return store._add_node(
        StructuredBundleResource(_RAY_PATH_BUNDLE_TAG, members, metadata, wire),
        created,
    )
