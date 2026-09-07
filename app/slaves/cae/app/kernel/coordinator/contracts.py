from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np

from app.kernel.api import BundleValue, FieldValue


def validate_artifact_payload(
    value: Any,
    contract: Mapping[str, Any],
    path: str,
    *,
    require_spatial_field: bool = False,
) -> None:
    """Validate the storage contract projected from a Catalog artifact type."""

    if contract.get("resourceKind") == "structuredBundle":
        if not isinstance(value, BundleValue):
            raise ValueError(f"{path} must be a BundleValue")
        members = value.members
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

    if require_spatial_field and not isinstance(value, FieldValue):
        raise ValueError(f"{path} must be a FieldValue")
    if isinstance(value, FieldValue):
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
    basis = contract.get("basis")
    if tensor_order and isinstance(basis, (list, tuple)):
        dimension = len(basis)
        if array.shape[len(axes) :] != (dimension,) * tensor_order:
            raise ValueError(
                f"{path} tensor components must have shape {(dimension,) * tensor_order!r}"
            )
