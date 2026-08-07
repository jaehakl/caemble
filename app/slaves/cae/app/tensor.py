from __future__ import annotations

import json
import math
from typing import Any

import numpy as np
from sdk.protocol.messages import DataChannelAttachment

from app.errors import CaeError

INLINE_LIMIT_BYTES = 64 * 1024
ATTACHMENT_SHARD_BYTES = 16 * 1024 * 1024
MAX_INPUT_BYTES = 256 * 1024 * 1024
MAX_RECORDED_BYTES = 64 * 1024 * 1024
MAX_SAFE_INTEGER = (1 << 53) - 1

_DTYPES: dict[str, np.dtype[Any]] = {
    "float16": np.dtype("<f2"),
    "float32": np.dtype("<f4"),
    "float64": np.dtype("<f8"),
    "int8": np.dtype("i1"),
    "uint8": np.dtype("u1"),
    "int16": np.dtype("<i2"),
    "uint16": np.dtype("<u2"),
    "int32": np.dtype("<i4"),
    "uint32": np.dtype("<u4"),
    "int64": np.dtype("<i8"),
    "uint64": np.dtype("<u8"),
    "bool": np.dtype("u1"),
}
def _is_finite_number(value: Any) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def dtype_for(name: str) -> np.dtype[Any]:
    try:
        return _DTYPES[name]
    except KeyError as exc:
        if name == "string":
            raise CaeError("invalid_tensor", "string tensors use UTF-8 JSON, not a NumPy dtype") from exc
        raise CaeError("invalid_schema", f"unsupported dtype: {name}") from exc


def validate_data_schema(schema: Any, path: str = "DataSchema") -> None:
    if not isinstance(schema, dict):
        raise CaeError("invalid_schema", f"{path} must be an object")
    allowed = {"dtype", "unit", "quantityKind", "tensorOrder", "basis", "axes"}
    if any(key not in allowed for key in schema):
        raise CaeError("invalid_schema", f"{path} contains unsupported fields")
    dtype_name = schema.get("dtype")
    if dtype_name != "string" and dtype_name not in _DTYPES:
        raise CaeError("invalid_schema", f"{path}.dtype is not supported")
    tensor_order = schema.get("tensorOrder")
    if (
        not isinstance(tensor_order, int)
        or isinstance(tensor_order, bool)
        or tensor_order < 0
    ):
        raise CaeError("invalid_schema", f"{path}.tensorOrder must be a non-negative integer")
    if isinstance(dtype_name, str) and dtype_name.startswith("float"):
        if not isinstance(schema.get("unit"), str) or not schema["unit"]:
            raise CaeError("invalid_schema", f"{path}.unit is required for a float dtype")
        if not isinstance(schema.get("quantityKind"), str) or not schema["quantityKind"]:
            raise CaeError("invalid_schema", f"{path}.quantityKind is required for a float dtype")
        basis = schema.get("basis")
        if tensor_order == 0 and basis is not None:
            raise CaeError("invalid_schema", f"{path}.basis is forbidden for a scalar QuantityKind")
        if tensor_order > 0:
            _validate_basis(basis, f"{path}.basis")
    else:
        if tensor_order != 0:
            raise CaeError("invalid_schema", f"{path}.tensorOrder must be 0 for a non-float dtype")
        if any(key in schema for key in ("unit", "quantityKind", "basis")):
            raise CaeError("invalid_schema", f"{path} non-float data must not contain quantity metadata")

    axes = schema.get("axes")
    if axes is None:
        return
    if not isinstance(axes, list) or not axes:
        raise CaeError("invalid_schema", f"{path}.axes must be a non-empty array")
    for index, axis in enumerate(axes):
        axis_path = f"{path}.axes[{index}]"
        if not isinstance(axis, dict) or any(
            key not in {"length", "name", "ticks", "unit", "quantityKind"} for key in axis
        ):
            raise CaeError("invalid_schema", f"{axis_path} is invalid")
        length = axis.get("length")
        if length is not None and (
            not isinstance(length, int) or isinstance(length, bool) or length <= 0
        ):
            raise CaeError("invalid_schema", f"{axis_path}.length must be a positive integer")
        if axis.get("name") is not None and (
            not isinstance(axis["name"], str) or not axis["name"].strip()
        ):
            raise CaeError("invalid_schema", f"{axis_path}.name must be non-empty")
        has_unit = "unit" in axis
        has_quantity = "quantityKind" in axis
        if has_unit != has_quantity or (
            has_unit
            and (
                not isinstance(axis["unit"], str)
                or not axis["unit"]
                or not isinstance(axis["quantityKind"], str)
                or not axis["quantityKind"]
            )
        ):
            raise CaeError("invalid_schema", f"{axis_path} quantity metadata is invalid")
        ticks = axis.get("ticks")
        if ticks is not None:
            if length is None or not isinstance(ticks, list) or len(ticks) != length:
                raise CaeError("invalid_schema", f"{axis_path}.ticks must match the fixed length")
            if any(
                not isinstance(tick, str)
                and not _is_finite_number(tick)
                for tick in ticks
            ):
                raise CaeError("invalid_schema", f"{axis_path}.ticks must contain finite numbers or strings")


def _validate_basis(value: Any, path: str) -> None:
    if (
        not isinstance(value, list)
        or len(value) != 3
        or any(
            not isinstance(row, list)
            or len(row) != 3
            or any(
                not _is_finite_number(item)
                for item in row
            )
            for row in value
        )
    ):
        raise CaeError("invalid_schema", f"{path} must be a 3 by 3 finite matrix")
    matrix = np.asarray(value, dtype=np.float64)
    if not np.allclose(matrix @ matrix.T, np.eye(3), rtol=0, atol=1e-9):
        raise CaeError("invalid_schema", f"{path} must be orthonormal")
    determinant = float(np.linalg.det(matrix))
    if not math.isclose(determinant, 1, rel_tol=0, abs_tol=1e-9):
        raise CaeError("invalid_schema", f"{path} must be right-handed")


def element_count(shape: list[int]) -> int:
    count = 1
    for length in shape:
        if not isinstance(length, int) or isinstance(length, bool) or length < 0:
            raise CaeError("invalid_tensor", "tensor shape must contain non-negative integers")
        count *= length
        if count > MAX_INPUT_BYTES:
            raise CaeError("resource_limit", "tensor shape is too large")
    return count


def decode_attachment_tensors(value: Any, attachments: list[DataChannelAttachment]) -> Any:
    files = {attachment.id: attachment.data for attachment in attachments}
    if len(files) != len(attachments):
        raise CaeError("invalid_attachment", "attachment ids must be unique")
    if any(len(data) > ATTACHMENT_SHARD_BYTES for data in files.values()):
        raise CaeError("invalid_attachment", "request attachment shards must not exceed 16 MiB")
    try:
        json_bytes = len(
            json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        )
    except (TypeError, ValueError) as exc:
        raise CaeError("invalid_input", "start payload must contain finite JSON values") from exc
    total_bytes = json_bytes + sum(len(data) for data in files.values())
    if total_bytes > MAX_INPUT_BYTES:
        raise CaeError("resource_limit", "BuiltSample/BuiltSetup input exceeds 256 MiB")
    used: set[str] = set()
    if isinstance(value, dict) and value.get("kind") == "cae.start.payload-attachments":
        if (
            set(value) != {"kind", "storage"}
            or not isinstance(value.get("storage"), dict)
            or set(value["storage"]) != {"kind", "ids", "byteLength"}
            or value["storage"].get("kind") != "attachments"
        ):
            raise CaeError("invalid_attachment", "start payload attachment envelope is invalid")
        ids = value["storage"].get("ids")
        declared = value["storage"].get("byteLength")
        if (
            not isinstance(ids, list)
            or not ids
            or any(not isinstance(item, str) for item in ids)
            or len(ids) != len(set(ids))
        ):
            raise CaeError("invalid_attachment", "start payload attachment ids are invalid")
        try:
            raw_payload = b"".join(files[item] for item in ids)
        except KeyError as exc:
            raise CaeError("invalid_attachment", f"missing attachment: {exc.args[0]}") from exc
        if declared != len(raw_payload):
            raise CaeError("invalid_attachment", "start payload byteLength does not match received bytes")
        try:
            value = json.loads(raw_payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise CaeError("invalid_attachment", "start payload attachment must contain UTF-8 JSON") from exc
        used.update(ids)

    def decode(node: Any, key: str | None = None, dtype_hint: str | None = None) -> Any:
        if isinstance(node, list):
            return [decode(item, dtype_hint=dtype_hint) for item in node]
        if not isinstance(node, dict):
            return node
        storage = node.get("storage")
        shape = node.get("shape")
        if isinstance(storage, dict) and storage.get("kind") == "attachments" and isinstance(shape, list):
            ids = storage.get("ids")
            byte_length = storage.get("byteLength")
            if not isinstance(ids, list) or not ids or any(not isinstance(item, str) for item in ids):
                raise CaeError("invalid_attachment", "attachment tensor ids are invalid")
            if len(ids) != len(set(ids)):
                raise CaeError("invalid_attachment", "attachment tensor ids must be unique")
            try:
                raw = b"".join(files[item] for item in ids)
            except KeyError as exc:
                raise CaeError("invalid_attachment", f"missing attachment: {exc.args[0]}") from exc
            used.update(ids)
            if byte_length != len(raw):
                raise CaeError("invalid_attachment", "attachment tensor byteLength does not match received bytes")
            dtype_name = node.get("dtype")
            if not isinstance(dtype_name, str):
                dtype_name = (
                    dtype_hint
                    or ("float64" if key == "positions" else "uint32" if key == "polygonOffsets" else None)
                )
            if dtype_name is None:
                raise CaeError("invalid_schema", "attachment tensor requires a surrounding dtype")
            if dtype_name == "string":
                try:
                    decoded = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise CaeError("invalid_tensor", "string tensor must contain UTF-8 JSON") from exc
                return decoded
            dtype = dtype_for(dtype_name)
            expected = element_count(shape) * dtype.itemsize
            if expected != len(raw):
                raise CaeError("invalid_tensor", "tensor shape and dtype do not match byteLength")
            array = np.frombuffer(raw, dtype=dtype).reshape(tuple(shape), order="C")
            if dtype_name == "bool":
                if np.any(array > 1):
                    raise CaeError("invalid_tensor", "bool tensor bytes must be 0 or 1")
                return array.astype(np.bool_)
            _validate_numeric_range("request attachment", array, dtype)
            return array
        descriptor_dtype = node.get("dtype") if isinstance(node.get("dtype"), str) else None
        return {
            name: decode(item, name, descriptor_dtype if name == "value" else None)
            for name, item in node.items()
        }

    result = decode(value)
    unused = set(files) - used
    if unused:
        raise CaeError("invalid_attachment", f"unused request attachment: {sorted(unused)[0]}")
    return result


def encode_tensor(
    name: str,
    schema: dict[str, Any],
    value: Any,
    sequence: int,
    *,
    max_byte_length: int | None = None,
) -> tuple[dict[str, Any], list[DataChannelAttachment], int]:
    validate_data_schema(schema, f"RecordedData {name}")
    axes = None
    raw_value = value
    if isinstance(value, dict) and "value" in value:
        raw_value = value["value"]
        axes = value.get("axes")
    dtype_name = schema.get("dtype")
    if not isinstance(dtype_name, str):
        raise CaeError("invalid_schema", f"RecordedData {name} has no dtype")

    if dtype_name == "string":
        shape, normalized = _string_shape_and_value(raw_value)
        raw = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        _validate_shape(schema, shape, axes)
        if max_byte_length is not None and len(raw) > max_byte_length:
            raise CaeError("resource_limit", "RecordedData raw bytes exceed 64 MiB")
        if len(raw) <= INLINE_LIMIT_BYTES:
            return _inline_tensor(shape, axes, normalized), [], len(raw)
        attachments = _shard(name, sequence, raw, "application/json; charset=utf-8")
        return _attachment_tensor(shape, axes, attachments, len(raw)), attachments, len(raw)

    dtype = dtype_for(dtype_name)
    try:
        array = np.asarray(raw_value)
    except Exception as exc:
        raise CaeError("invalid_tensor", f"RecordedData {name} is not tensor-like") from exc
    shape = list(array.shape)
    _validate_shape(schema, shape, axes)
    byte_length = element_count(shape) * dtype.itemsize
    if max_byte_length is not None and byte_length > max_byte_length:
        raise CaeError("resource_limit", "RecordedData raw bytes exceed 64 MiB")
    if dtype_name == "bool":
        if array.dtype.kind not in "bui" or np.any((array != 0) & (array != 1)):
            raise CaeError("invalid_tensor", f"RecordedData {name} contains a non-boolean value")
        encoded = np.asarray(array, dtype=np.uint8, order="C")
    else:
        _validate_numeric_range(name, array, dtype)
        encoded = np.asarray(array, dtype=dtype, order="C")
    raw = encoded.tobytes(order="C")
    if len(raw) != byte_length:
        raise CaeError("invalid_tensor", f"RecordedData {name} byteLength is inconsistent")

    if encoded.ndim == 0 or len(raw) <= INLINE_LIMIT_BYTES:
        if dtype_name == "bool":
            boolean = encoded.astype(np.bool_)
            inline_value = boolean.item() if boolean.ndim == 0 else boolean.tolist()
        else:
            inline_value = encoded.item() if encoded.ndim == 0 else encoded.tolist()
        return _inline_tensor(shape, axes, inline_value), [], len(raw)
    attachments = _shard(name, sequence, raw, "application/octet-stream")
    return _attachment_tensor(shape, axes, attachments, len(raw)), attachments, len(raw)


def validate_tensor_value(name: str, schema: dict[str, Any], value: Any) -> None:
    validate_data_schema(schema, name)
    axes = None
    raw_value = value
    if isinstance(value, dict) and "value" in value:
        raw_value = value["value"]
        axes = value.get("axes")
    dtype_name = schema.get("dtype")
    if not isinstance(dtype_name, str):
        raise CaeError("invalid_schema", f"{name} has no dtype")
    if dtype_name == "string":
        shape, _normalized = _string_shape_and_value(raw_value)
        _validate_shape(schema, shape, axes)
        return
    dtype = dtype_for(dtype_name)
    try:
        array = np.asarray(raw_value)
    except Exception as exc:
        raise CaeError("invalid_tensor", f"{name} is not tensor-like") from exc
    _validate_shape(schema, list(array.shape), axes)
    if dtype_name == "bool":
        if array.dtype.kind not in "bui" or np.any((array != 0) & (array != 1)):
            raise CaeError("invalid_tensor", f"{name} contains a non-boolean value")
        return
    _validate_numeric_range(name, array, dtype)


def _validate_numeric_range(name: str, array: np.ndarray[Any, Any], dtype: np.dtype[Any]) -> None:
    if array.dtype.kind not in "biuf":
        raise CaeError("invalid_tensor", f"RecordedData {name} must contain numeric values")
    if array.dtype.kind == "f" and not np.all(np.isfinite(array)):
        raise CaeError("invalid_tensor", f"RecordedData {name} contains a non-finite value")
    if dtype.kind in "iu":
        if array.dtype.kind == "f" and np.any(array != np.trunc(array)):
            raise CaeError("invalid_tensor", f"RecordedData {name} contains a fractional integer value")
        limits = np.iinfo(dtype)
        minimum = max(int(limits.min), -MAX_SAFE_INTEGER)
        maximum = min(int(limits.max), MAX_SAFE_INTEGER)
        if np.any(array < minimum) or np.any(array > maximum):
            raise CaeError("invalid_tensor", f"RecordedData {name} exceeds {dtype.name} range")
    elif dtype.kind == "f":
        limits = np.finfo(dtype)
        if np.any(np.abs(array) > limits.max):
            raise CaeError("invalid_tensor", f"RecordedData {name} exceeds {dtype.name} range")


def _validate_shape(schema: dict[str, Any], shape: list[int], axes: Any) -> None:
    schema_axes = schema.get("axes") or []
    if not isinstance(schema_axes, list):
        raise CaeError("invalid_schema", "DataSchema axes must be an array")
    component_order = schema.get("tensorOrder")
    if not isinstance(component_order, int) or isinstance(component_order, bool) or component_order < 0:
        raise CaeError("invalid_schema", "DataSchema tensor order is invalid")
    expected_rank = len(schema_axes) + component_order
    if len(shape) != expected_rank:
        raise CaeError(
            "invalid_tensor",
            f"tensor rank {len(shape)} does not match {len(schema_axes)} axes plus tensor order {component_order}",
        )
    has_dynamic_axis = False
    for index, axis in enumerate(schema_axes):
        if not isinstance(axis, dict):
            raise CaeError("invalid_schema", "DataSchema axis must be an object")
        length = axis.get("length")
        if length is not None and shape[index] != length:
            raise CaeError("invalid_tensor", f"tensor axis {index} length does not match DataSchema")
        if length is None:
            has_dynamic_axis = True
    if component_order and shape[-component_order:] != [3] * component_order:
        raise CaeError("invalid_tensor", "tensor component shape must use length 3 for each tensor order")
    if axes is None:
        if has_dynamic_axis:
            raise CaeError("invalid_tensor", "tensor axes and ticks are required for a dynamic DataSchema axis")
        return
    if not isinstance(axes, list) or len(axes) != len(schema_axes):
        raise CaeError("invalid_tensor", "tensor axes do not match DataSchema rank")
    for index, axis in enumerate(axes):
        if not isinstance(axis, dict) or any(key != "ticks" for key in axis):
            raise CaeError("invalid_tensor", f"tensor axis {index} may contain only ticks")
        ticks = axis.get("ticks")
        schema_ticks = schema_axes[index].get("ticks")
        if ticks is None:
            if schema_axes[index].get("length") is None:
                raise CaeError("invalid_tensor", f"tensor axis {index} ticks are required for a dynamic axis")
            continue
        if not isinstance(ticks, list) or len(ticks) != shape[index]:
            raise CaeError("invalid_tensor", f"tensor axis {index} ticks do not match shape")
        if any(
            not isinstance(tick, str)
            and not _is_finite_number(tick)
            for tick in ticks
        ):
            raise CaeError("invalid_tensor", f"tensor axis {index} ticks must be finite numbers or strings")
        if schema_ticks is not None and ticks != schema_ticks:
            raise CaeError("invalid_tensor", f"tensor axis {index} ticks do not match DataSchema")


def _string_shape_and_value(value: Any) -> tuple[list[int], Any]:
    if isinstance(value, str):
        return [], value
    array = np.asarray(value, dtype=object)
    if any(not isinstance(item, str) for item in array.flat):
        raise CaeError("invalid_tensor", "string tensor values must all be strings")
    return list(array.shape), array.tolist()


def _inline_tensor(shape: list[int], axes: Any, value: Any) -> dict[str, Any]:
    return {
        "shape": shape,
        **({"axes": axes} if axes is not None else {}),
        "storage": {"kind": "inline", "value": value},
    }


def _attachment_tensor(
    shape: list[int],
    axes: Any,
    attachments: list[DataChannelAttachment],
    byte_length: int,
) -> dict[str, Any]:
    return {
        "shape": shape,
        **({"axes": axes} if axes is not None else {}),
        "storage": {
            "kind": "attachments",
            "ids": [attachment.id for attachment in attachments],
            "byteLength": byte_length,
        },
    }


def _shard(
    name: str,
    sequence: int,
    raw: bytes,
    mime_type: str,
) -> list[DataChannelAttachment]:
    count = max(1, math.ceil(len(raw) / ATTACHMENT_SHARD_BYTES))
    return [
        DataChannelAttachment(
            id=f"record-{sequence}-{index}",
            name=f"{name}.{index + 1:04d}-of-{count:04d}.bin",
            mimeType=mime_type,
            data=raw[index * ATTACHMENT_SHARD_BYTES : (index + 1) * ATTACHMENT_SHARD_BYTES],
        )
        for index in range(count)
    ]
