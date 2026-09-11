from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np

from app.kernel.api.errors import CaeError
from app.kernel.api.values import (
    BundleValue,
    FieldValue,
    ParticleSetValue,
    RaySetValue,
    StructuredGridValue,
    UnstructuredMeshValue,
)
from app.kernel.resources import ArtifactHandle, ArtifactStore, ResourceLease, ResourceStore


def materialize_record_value(
    value: Any,
    schema: Mapping[str, Any],
    *,
    resources: ResourceStore,
    artifacts: ArtifactStore,
    owner: str,
    leases: list[ResourceLease],
    _select_members: bool = False,
) -> Any:
    """Project live artifacts and detached values onto an existing record schema.

    The caller transfers the accumulated leases to the ACK-owned record packet.
    Tensor leaves retain their historical value/axes representation; explicitly
    declared groups can retain domains without introducing a new wire format.
    """
    if isinstance(value, ArtifactHandle):
        if not artifacts.is_live(value):
            raise CaeError("invalid_record", "RecordedData references a released or foreign artifact")
        leases.append(resources.acquire(value.resource_ref, owner=owner))
        value = artifacts.materialize(value, copy_arrays=False)
        if "dtype" in schema and isinstance(value, Mapping) and "value" in value:
            axes = value.get("axes")
            return {"value": value["value"], "axes": axes} if axes is not None else value["value"]

    project_members = _select_members or isinstance(
        value, (FieldValue, StructuredGridValue, UnstructuredMeshValue, ParticleSetValue, RaySetValue)
    )
    if isinstance(value, FieldValue):
        if "dtype" in schema:
            if isinstance(value.domain, StructuredGridValue):
                return {"value": value.values, "axes": _structured_field_axes(value, schema)}
            axes = schema.get("axes", [])
            if any("ticks" not in axis and (axis.get("unit") or axis.get("quantityKind") or
                   axis.get("name") in ("time", "frequency", "sample")) for axis in axes):
                raise CaeError("invalid_record", "Unstructured field cannot supply physical axis coordinates")
            return {"value": value.values, "axes": [
                {"ticks": axis["ticks"]} if "ticks" in axis else {"implicitOrdinal": True} for axis in axes
            ]}
        field_values = value.values
        if isinstance(value.domain, StructuredGridValue):
            field_values = {"value": value.values, "axes": _structured_field_axes(value, schema.get("values", {}))}
        value = {
            "domain": value.domain,
            "location": str(value.location),
            "quantity": value.quantity_kind,
            "valueUnit": value.unit,
            "values": field_values,
            **({"components": value.components} if value.components is not None else {}),
            **({"componentBasis": value.basis} if value.basis is not None else {}),
            "metadata": value.metadata,
        }
    elif isinstance(value, StructuredGridValue):
        value = {
            "kind": "structured-grid",
            **({"identity": value.identity} if value.identity is not None else {}),
            "lengthUnit": value.unit,
            "shape": value.shape,
            "coordinates": {f"axis{index}": axis for index, axis in enumerate(value.axes)},
            "metadata": value.metadata,
        }
    elif isinstance(value, UnstructuredMeshValue):
        value = {
            "kind": "unstructured-mesh",
            **({"identity": value.identity} if value.identity is not None else {}),
            "lengthUnit": value.unit,
            "points": value.points,
            "cells": value.cells,
            "metadata": value.metadata,
        }
    elif isinstance(value, ParticleSetValue):
        value = {
            "kind": "particle-set",
            **({"identity": value.identity} if value.identity is not None else {}),
            "lengthUnit": value.unit,
            "positions": value.positions,
            "attributes": value.attributes,
            "metadata": value.metadata,
        }
    elif isinstance(value, RaySetValue):
        value = {
            "kind": "ray-set",
            **({"identity": value.identity} if value.identity is not None else {}),
            "lengthUnit": value.unit,
            "origins": value.origins,
            "directions": value.directions,
            "attributes": value.attributes,
            "metadata": value.metadata,
        }
    elif isinstance(value, BundleValue):
        value = value.members

    if "dtype" in schema and isinstance(value, Mapping) and "value" in value:
        return value
    if project_members and "dtype" in schema and schema.get("axes"):
        axes = schema["axes"]
        if all(not axis.get("unit") and not axis.get("quantityKind") and
               axis.get("name") not in ("time", "frequency", "sample") for axis in axes):
            return {"value": value, "axes": [
                {"ticks": axis["ticks"]} if "ticks" in axis else {"implicitOrdinal": True}
                for axis in axes
            ]}
    if isinstance(value, Mapping):
        members = schema if project_members and "dtype" not in schema else value
        return {
            name: materialize_record_value(
                value[name], schema if "dtype" in schema else schema.get(name, {}),
                resources=resources, artifacts=artifacts, owner=owner, leases=leases,
                _select_members=project_members,
            )
            for name in members
        }
    if isinstance(value, (list, tuple)):
        return type(value)(
            materialize_record_value(
                item, schema, resources=resources, artifacts=artifacts, owner=owner, leases=leases,
                _select_members=project_members,
            )
            for item in value
        )
    return value


def _structured_field_axes(value: FieldValue, schema: Mapping[str, Any]) -> list[dict[str, Any]]:
    domain = value.domain
    spacings = domain.metadata.get("spacings")
    bounds = domain.metadata.get("bounds")
    spatial_axes = [
        {"ticks": axis,
         **({"spacing": spacings[index]} if spacings is not None else {}),
         **({"bounds": bounds[index]} if bounds is not None else {})}
        for index, axis in enumerate(domain.axes)
    ]
    samples = value.metadata.get("sampleAxes")
    if samples is None:
        return spatial_axes
    # Sample coordinates are not spatial domain axes (Hz/s must never become metres).
    if not isinstance(samples, (list, tuple)) or not samples:
        raise CaeError("invalid_record", "Field sampleAxes must be a nonempty sequence")
    schema_axes = schema.get("axes", ())
    if len(schema_axes) != len(samples) + len(spatial_axes):
        raise CaeError("invalid_record", "Field sample and spatial axes do not match the recording schema")
    recorded = []
    for index, axis in enumerate(samples):
        if not isinstance(axis, Mapping) or "ticks" not in axis:
            raise CaeError("invalid_record", "Field sample axis must contain coordinates")
        ticks = np.asarray(axis["ticks"])
        if ticks.ndim != 1 or not np.issubdtype(ticks.dtype, np.number) or not np.all(np.isfinite(ticks)):
            raise CaeError("invalid_record", "Field sample coordinates must be finite numeric vectors")
        if axis.get("unit") != schema_axes[index].get("unit") or axis.get("name") != schema_axes[index].get("name"):
            raise CaeError("invalid_record", "Field sample axis meaning differs from the recording schema")
        recorded.append(dict(axis))
    expected = tuple(len(axis["ticks"]) for axis in recorded) + domain.shape
    if value.values.shape[:len(expected)] != expected:
        raise CaeError("invalid_record", "Field sample and spatial coordinates do not match its values")
    return recorded + spatial_axes
