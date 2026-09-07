from __future__ import annotations

import json
import math
from collections.abc import Mapping
from typing import Any

import numpy as np
from sdk.protocol.messages import DataChannelAttachment

INLINE_LIMIT_BYTES = 64 * 1024
ATTACHMENT_SHARD_BYTES = 16 * 1024 * 1024

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


def dtype_for(name: str) -> np.dtype[Any]:
    return _DTYPES[name]


def decode_attachment_tensors(value: Any, attachments: list[DataChannelAttachment]) -> Any:
    files = {attachment.id: attachment.data for attachment in attachments}
    if isinstance(value, dict) and value.get("kind") == "cae.start.payload-attachments":
        raw_payload = b"".join(files[item] for item in value["storage"]["ids"])
        value = json.loads(raw_payload.decode("utf-8"))

    def decode(node: Any, dtype_hint: str | None = None) -> Any:
        if isinstance(node, list):
            return [decode(item, dtype_hint=dtype_hint) for item in node]
        if not isinstance(node, dict):
            return node
        storage = node.get("storage")
        shape = node.get("shape")
        if isinstance(storage, dict) and storage.get("kind") == "attachments" and isinstance(shape, list):
            raw = b"".join(files[item] for item in storage["ids"])
            dtype_name = node.get("dtype") or dtype_hint
            if dtype_name == "string":
                return json.loads(raw.decode("utf-8"))
            array = np.frombuffer(raw, dtype=dtype_for(dtype_name)).reshape(tuple(shape), order="C")
            return array.astype(np.bool_) if dtype_name == "bool" else array
        descriptor_dtype = node.get("dtype") if isinstance(node.get("dtype"), str) else None
        return {
            name: decode(item, descriptor_dtype if name == "value" else None)
            for name, item in node.items()
        }

    return decode(value)


def encode_tensor(
    name: str,
    schema: dict[str, Any],
    value: Any,
    sequence: int,
) -> tuple[dict[str, Any], list[DataChannelAttachment], int]:
    axes = None
    raw_value = value
    if isinstance(value, dict) and "value" in value:
        raw_value = value["value"]
        axes = _materialize_metadata(value.get("axes"))
    dtype_name = schema["dtype"]

    if dtype_name == "string":
        if isinstance(raw_value, str):
            shape: list[int] = []
            normalized = raw_value
        else:
            array = np.asarray(raw_value, dtype=object)
            shape = list(array.shape)
            normalized = array.tolist()
        raw = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(raw) <= INLINE_LIMIT_BYTES and not is_ray_path_recorded_data_name(name):
            return _inline_tensor(shape, axes, normalized), [], len(raw)
        attachments = _shard(name, sequence, raw, "application/json; charset=utf-8")
        return _attachment_tensor(shape, axes, attachments, len(raw)), attachments, len(raw)

    encoded = np.asarray(raw_value, dtype=dtype_for(dtype_name), order="C")
    shape = list(encoded.shape)
    raw = encoded.tobytes(order="C")
    if encoded.ndim == 0 or (
        len(raw) <= INLINE_LIMIT_BYTES and not is_ray_path_recorded_data_name(name)
    ):
        inline_value = encoded.item() if encoded.ndim == 0 else encoded.tolist()
        if dtype_name == "bool":
            inline_value = bool(inline_value) if encoded.ndim == 0 else encoded.astype(np.bool_).tolist()
        return _inline_tensor(shape, axes, inline_value), [], len(raw)
    attachments = _shard(name, sequence, raw, "application/octet-stream")
    return _attachment_tensor(shape, axes, attachments, len(raw)), attachments, len(raw)


def _materialize_metadata(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, Mapping):
        return {name: _materialize_metadata(item) for name, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_materialize_metadata(item) for item in value]
    return value


def is_ray_path_recorded_data_name(name: str) -> bool:
    return name.startswith("rayPaths.")


def encode_recorded_data(
    name: str,
    schema: dict[str, Any],
    value: Any,
    sequence: int,
) -> tuple[dict[str, Any], list[DataChannelAttachment], int]:
    if "dtype" in schema:
        return encode_tensor(name, schema, value, sequence)
    encoded: dict[str, Any] = {}
    attachments: list[DataChannelAttachment] = []
    byte_length = 0
    for member_name, member_schema in schema.items():
        member, member_attachments, member_bytes = encode_recorded_data(
            f"{name}.{member_name}", member_schema, value[member_name], sequence
        )
        encoded[member_name] = member
        attachments.extend(member_attachments)
        byte_length += member_bytes
    return encoded, attachments, byte_length


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
            id=f"record-{sequence}-{name.replace('.', '-')}-{index}",
            name=f"{name}.{index + 1:04d}-of-{count:04d}.bin",
            mimeType=mime_type,
            data=raw[index * ATTACHMENT_SHARD_BYTES : (index + 1) * ATTACHMENT_SHARD_BYTES],
        )
        for index in range(count)
    ]
