from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from .errors import GpStationProtocolError


def encode_binary_frame(header: Mapping[str, Any], body: bytes) -> bytes:
    header_bytes = json.dumps(dict(header), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return len(header_bytes).to_bytes(4, "big") + header_bytes + body


def decode_binary_frame(frame: bytes) -> tuple[dict[str, Any], bytes]:
    if len(frame) < 4:
        raise GpStationProtocolError("binary frame is too short")
    header_length = int.from_bytes(frame[:4], "big")
    if header_length <= 0 or len(frame) < 4 + header_length:
        raise GpStationProtocolError("invalid binary frame header length")
    try:
        header = json.loads(frame[4 : 4 + header_length].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GpStationProtocolError(f"invalid binary frame header: {exc}") from exc
    if not isinstance(header, dict):
        raise GpStationProtocolError("binary frame header must be an object")
    return header, frame[4 + header_length :]
