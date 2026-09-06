from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.errors import CaeError
from app.runtime_kernel.api.values import (
    BundleValue,
    FieldValue,
    ParticleSetValue,
    RaySetValue,
    StructuredGridValue,
    UnstructuredMeshValue,
)
from app.runtime_kernel.resources import ArtifactHandle, ArtifactStore, ResourceLease, ResourceStore


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
            domain = value.get("domainRef")
            if axes is None and isinstance(domain, Mapping):
                axes = domain.get("axes")
            return {"value": value["value"], "axes": axes} if axes is not None else value["value"]

    project_members = _select_members or isinstance(
        value, (FieldValue, StructuredGridValue, UnstructuredMeshValue, ParticleSetValue, RaySetValue)
    )
    if isinstance(value, FieldValue):
        if "dtype" in schema:
            if isinstance(value.domain, StructuredGridValue):
                return {"value": value.values, "axes": [{"ticks": axis} for axis in value.domain.axes]}
            if isinstance(value.domain, Mapping) and value.domain.get("axes") is not None:
                return {"value": value.values, "axes": value.domain["axes"]}
            return value.values
        value = {
            "domain": value.domain,
            "location": str(value.location),
            "quantity": value.quantity_kind,
            "valueUnit": value.unit,
            "values": value.values,
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
