from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import numpy as np

from app.kernel.api import BundleValue, FieldValue, ParticleSetValue, QuantityArrayValue
from caemble_catalog.result_metadata import validate_result_metadata


def validate_artifact_payload(
    value: Any,
    contract: Mapping[str, Any],
    path: str,
    *,
    require_spatial_field: bool = False,
) -> None:
    """Validate the storage contract projected from a Catalog artifact type."""

    if contract.get("resourceKind") == "particleSet":
        if not isinstance(value, ParticleSetValue):
            raise ValueError(f"{path} must be a ParticleSetValue")
        if value.unit != contract.get("coordinateUnit") or value.coordinate_frame != contract.get("coordinateFrame", "world"):
            raise ValueError(f"{path} particle coordinates differ from its artifact contract")
        expected = contract.get("attributes", {})
        if set(value.attributes) != set(expected):
            raise ValueError(f"{path} particle attributes differ from its artifact contract")
        for name, attribute in value.attributes.items():
            validate_artifact_payload(attribute, expected[name], f"{path}.attributes.{name}")
        return

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
    if isinstance(value, (FieldValue, QuantityArrayValue)):
        if value.quantity_kind != contract.get("quantityKind") or value.unit != contract.get("unit"):
            raise ValueError(f"{path} quantity or unit differs from its artifact contract")
        if require_spatial_field:
            if value.location.value not in {"node", "edge", "face", "cell", "particle"}:
                raise ValueError(f"{path}.location is not spatial")
        raw = value.values
    elif isinstance(value, Mapping):
        if "value" not in value:
            raise ValueError(f"{path} must contain a value")
        raw = value["value"]
    else:
        raw = value

    if "metadata" in contract:
        metadata = value.metadata if isinstance(value, (FieldValue, QuantityArrayValue)) else value.get("metadata") if isinstance(value, Mapping) else None
        validate_result_metadata(contract["metadata"], metadata, f"{path}.metadata", allow_extra=isinstance(value, (FieldValue, QuantityArrayValue)))
    if "mesh" in contract:
        from app.kernel.api import UnstructuredMeshValue
        mesh = contract["mesh"]
        if (not isinstance(value, FieldValue) or not isinstance(value.domain, UnstructuredMeshValue)
                or mesh.get("version") != 1 or set(value.domain.cells) != {mesh.get("cellType")}):
            raise ValueError(f"{path} mesh differs from its declared topology")

    if "boxGrid" in contract:
        profile = contract["boxGrid"]
        if not isinstance(value, Mapping) or not isinstance(value.get("boxGrid"), Mapping):
            raise ValueError(f"{path} must carry its Box Grid geometry")
        grid = value["boxGrid"]
        if any(not np.array_equal(grid.get(key), expected) for key, expected in profile.items()):
            raise ValueError(f"{path}.boxGrid differs from its output profile")
        shape = tuple(grid["gridShape"])
        array = np.asarray(raw)
        if (array.ndim != 7 or any(size < 1 for size in array.shape) or array.shape[:3] != shape
                or array.shape[-2:] != (len(profile["channels"]), len(profile["components"]))):
            raise ValueError(f"{path} must have x/y/z/time/frequency/amplitudePhase/component dimensions")
        if profile["sampling"] == "aggregate" and shape != (1, 1, 1):
            raise ValueError(f"{path} aggregate outputs require gridShape [1, 1, 1]")
        if profile["sampling"] == "surface-integral" and shape[2] != 1:
            raise ValueError(f"{path} surface-integral outputs require one z cell")
        axes = value.get("axes")
        if not isinstance(axes, (list, tuple)) or len(axes) != 7:
            raise ValueError(f"{path} requires all seven coordinate axes")
        for axis, size in zip(axes, array.shape, strict=True):
            if len(axis.get("ticks", ())) != size:
                raise ValueError(f"{path} coordinate length differs from its tensor shape")
        if np.iscomplexobj(array) or not np.all(np.isfinite(array)):
            raise ValueError(f"{path} requires finite real channel values")
        if tuple(profile["channels"]) == ("amplitude", "phase"):
            amplitude, phase = array[..., 0, :], array[..., 1, :].astype(np.float64)
            if (np.any(amplitude < 0) or np.any(phase < -np.pi) or np.any(phase >= np.pi)
                    or np.any(phase[amplitude == 0] != 0)):
                raise ValueError(f"{path} requires nonnegative amplitude and phase in [-pi, pi), zero when amplitude is zero")

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
    explicit_components = isinstance(value, (FieldValue, QuantityArrayValue)) and value.components is not None
    expected_rank = len(axes) + (1 if tensor_order and explicit_components else tensor_order)
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
    if tensor_order and isinstance(basis, (list, tuple)) and not explicit_components:
        dimension = len(basis)
        if array.shape[len(axes) :] != (dimension,) * tensor_order:
            raise ValueError(
                f"{path} tensor components must have shape {(dimension,) * tensor_order!r}"
            )
