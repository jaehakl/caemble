"""Domain-independent serialization, search escaping and bounded tensor reads."""
from __future__ import annotations

import base64
import hashlib
import json
import math
import struct
from datetime import date, datetime
from itertools import islice
from typing import Any, Iterable


class VisibleDataError(ValueError):
    pass


def slice_recorded_tensor(data: Any, dtype: str, offset: int, count: int) -> dict[str, Any]:
    shape = data["shape"]
    storage = data["storage"]
    total = math.prod(shape) if shape else 1
    if offset < 0 or offset > total or count < 1 or count > 10000:
        raise VisibleDataError("Slice offset or count is outside the available tensor.")
    selected_count = min(count, total - offset)
    if storage.get("kind") == "inline":
        return _slice_inline(storage.get("value"), shape, total, offset, count)
    if dtype == "string":
        value = json.loads(base64.b64decode(storage["data"]).decode("utf-8"))
        return _slice_inline(value, shape, total, offset, count)
    format_code = _DTYPE_FORMATS[dtype]
    values = _decode_base64_slice(storage["data"], format_code, offset, selected_count)
    next_offset = offset + len(values)
    return {
        "shape": shape,
        "totalValues": total,
        "offset": offset,
        "values": values,
        "nextOffset": next_offset if next_offset < total else None,
    }


_DTYPE_FORMATS = {
    "complex64": "ff",
    "bool": "?",
    "int8": "b",
    "uint8": "B",
    "int16": "h",
    "uint16": "H",
    "int32": "i",
    "uint32": "I",
    "int64": "q",
    "uint64": "Q",
    "float16": "e",
    "float32": "f",
    "float64": "d",
}


def _decode_base64_slice(encoded: str, format_code: str, offset: int, count: int) -> list[Any]:
    if count == 0:
        return []
    item_size = struct.calcsize(f"<{format_code}")
    byte_start = offset * item_size
    byte_end = byte_start + count * item_size
    character_start = (byte_start // 3) * 4
    character_end = ((byte_end + 2) // 3) * 4
    decoded = base64.b64decode(encoded[character_start:character_end])
    local_start = byte_start - (character_start // 4) * 3
    selected = decoded[local_start : local_start + count * item_size]
    if format_code == "ff":
        return [{"re": re, "im": im} for re, im in struct.iter_unpack("<ff", selected)]
    return list(struct.unpack(f"<{count}{format_code}", selected))


def _slice_inline(
    value: Any,
    shape: list[int],
    total: int,
    offset: int,
    count: int,
) -> dict[str, Any]:
    selected_count = min(count, total - offset)
    selected = list(islice(_flatten_inline(value), offset, offset + selected_count))
    next_offset = offset + len(selected)
    return {
        "shape": shape,
        "totalValues": total,
        "offset": offset,
        "values": selected,
        "nextOffset": next_offset if next_offset < total else None,
    }


def _flatten_inline(value: Any) -> Iterable[Any]:
    if isinstance(value, list):
        for item in value:
            yield from _flatten_inline(item)
    else:
        yield value


def search_pattern(query: str) -> str:
    escaped = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def json_mapping(row: Any) -> dict[str, Any]:
    return {key: json_value(value) for key, value in row.items()}


def json_value(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def provenance(
    resource: str,
    resource_id: int,
    label: str,
) -> dict[str, Any]:
    return {
        "kind": "database",
        "label": label,
        "resourceType": resource,
        "resourceId": resource_id,
    }


def text_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
