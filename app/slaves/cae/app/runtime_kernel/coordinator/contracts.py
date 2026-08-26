from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np

from app.runtime_kernel.resources import Field, StructuredBundle


def validate_artifact_payload(
    value: Any,
    contract: Mapping[str, Any],
    path: str,
    *,
    require_spatial_field: bool = False,
) -> None:
    """Validate the storage contract projected from a Catalog artifact type."""

    if contract.get("resourceKind") == "structuredBundle":
        members = value.members if isinstance(value, StructuredBundle) else (
            value.get("members") if isinstance(value, Mapping) else None
        )
        if not isinstance(members, Mapping):
            raise ValueError(f"{path} must be a structured bundle")
        expected = contract.get("members")
        if not isinstance(expected, Mapping):
            raise ValueError(f"{path} has an invalid structured bundle contract")
        missing = sorted(set(expected) - set(members))
        unknown = sorted(set(members) - set(expected))
        if missing or unknown:
            details = []
            if missing:
                details.append(f"missing {missing!r}")
            if unknown:
                details.append(f"unknown {unknown!r}")
            raise ValueError(f"{path} has incorrect bundle members: {', '.join(details)}")
        for name, member_contract in expected.items():
            if not isinstance(member_contract, Mapping):
                raise ValueError(f"{path}.{name} has an invalid data contract")
            validate_artifact_payload(members[name], member_contract, f"{path}.{name}")
        return

    if isinstance(value, Field):
        if require_spatial_field:
            if value.location.value not in {"node", "edge", "face", "cell"}:
                raise ValueError(f"{path}.location is not spatial")
            if value.quantity_kind != contract.get("quantityKind"):
                raise ValueError(f"{path}.quantityKind does not match its artifact contract")
            if value.unit != contract.get("unit"):
                raise ValueError(f"{path}.unit does not match its artifact contract")
        raw = value.values
    elif isinstance(value, Mapping):
        if "value" not in value:
            raise ValueError(f"{path} must contain a value")
        if require_spatial_field:
            missing = sorted(
                {"domainRef", "location", "quantityKind", "unit"} - set(value)
            )
            if missing:
                raise ValueError(f"{path} field metadata is missing {missing!r}")
            if not isinstance(value.get("domainRef"), Mapping):
                raise ValueError(f"{path}.domainRef must identify a field domain")
            if value.get("location") not in {"node", "edge", "face", "cell"}:
                raise ValueError(f"{path}.location is not spatial")
            if value.get("quantityKind") != contract.get("quantityKind"):
                raise ValueError(f"{path}.quantityKind does not match its artifact contract")
            if value.get("unit") != contract.get("unit"):
                raise ValueError(f"{path}.unit does not match its artifact contract")
        elif "domainRef" in value or "location" in value:
            if not isinstance(value.get("domainRef"), Mapping):
                raise ValueError(f"{path}.domainRef must identify a field domain")
            if value.get("location") not in {
                "node",
                "edge",
                "face",
                "cell",
                "particle",
                "ray",
            }:
                raise ValueError(f"{path}.location is not a supported field location")
            if value.get("quantityKind") != contract.get("quantityKind"):
                raise ValueError(f"{path}.quantityKind does not match its artifact contract")
            if value.get("unit") != contract.get("unit"):
                raise ValueError(f"{path}.unit does not match its artifact contract")
        raw = value["value"]
    else:
        raw = value

    dtype = contract.get("dtype")
    if not isinstance(dtype, str) or not dtype:
        raise ValueError(f"{path} has no dtype contract")
    array = np.asarray(raw)
    if array.dtype.hasobject:
        raise ValueError(f"{path} contains ragged or object data")
    if dtype == "string":
        if array.dtype.kind not in {"U", "S"}:
            raise ValueError(f"{path} must have string values")
    elif array.dtype != np.dtype(dtype):
        raise ValueError(f"{path} must have dtype {dtype}, got {array.dtype}")

    axes = contract.get("axes", ())
    if not isinstance(axes, (list, tuple)):
        raise ValueError(f"{path} has an invalid axes contract")
    tensor_order = contract.get("tensorOrder", 0)
    if isinstance(tensor_order, bool) or not isinstance(tensor_order, int) or tensor_order < 0:
        raise ValueError(f"{path} has an invalid tensor order")
    expected_rank = len(axes) + tensor_order
    if array.ndim != expected_rank:
        raise ValueError(f"{path} must have rank {expected_rank}, got {array.ndim}")
    for index, axis in enumerate(axes):
        if not isinstance(axis, Mapping):
            raise ValueError(f"{path} axis {index} has an invalid contract")
        length = axis.get("length")
        if length is not None and array.shape[index] != length:
            raise ValueError(
                f"{path} axis {index} must have length {length}, got {array.shape[index]}"
            )
    if require_spatial_field and isinstance(value, Mapping):
        domain_ref = value["domainRef"]
        shape = domain_ref.get("shape")
        domain_axes = domain_ref.get("axes")
        if (
            not isinstance(domain_ref.get("id"), str)
            or not domain_ref["id"]
            or not isinstance(domain_ref.get("referenceLengthUnit"), str)
            or not domain_ref["referenceLengthUnit"]
            or not isinstance(shape, (list, tuple))
            or not isinstance(domain_axes, (list, tuple))
            or len(shape) != len(axes)
            or len(domain_axes) != len(shape)
        ):
            raise ValueError(f"{path}.domainRef is not a complete structured field domain")
        spatial_shape = tuple(int(size) for size in shape)
        if any(size <= 0 for size in spatial_shape) or array.shape[: len(axes)] != spatial_shape:
            raise ValueError(
                f"{path} field shape {array.shape[:len(axes)]!r} does not match "
                f"domainRef shape {spatial_shape!r}"
            )
    basis = contract.get("basis")
    if tensor_order and isinstance(basis, (list, tuple)):
        dimension = len(basis)
        if array.shape[len(axes) :] != (dimension,) * tensor_order:
            raise ValueError(
                f"{path} tensor components must have shape {(dimension,) * tensor_order!r}"
            )
