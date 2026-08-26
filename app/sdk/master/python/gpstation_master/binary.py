from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

def encode_binary_frame(header: Mapping[str, Any], body: bytes) -> bytes:
    header_bytes = json.dumps(dict(header), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return len(header_bytes).to_bytes(4, "big") + header_bytes + body


def decode_binary_frame(frame: bytes) -> tuple[dict[str, Any], bytes]:
    header_length = int.from_bytes(frame[:4], "big")
    header = json.loads(frame[4 : 4 + header_length].decode("utf-8"))
    return header, frame[4 + header_length :]
