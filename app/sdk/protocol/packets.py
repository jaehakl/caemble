"""Ordered WebSocket packets with bounded binary frames and no RTC dependency."""
from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from pydantic import BaseModel


CHUNK_BYTES = 256 * 1024


class Attachment(BaseModel):
    id: str
    name: str | None = None
    mimeType: str | None = None
    size: int | None = None
    data: bytes = b""


async def send_packet(
    send_text: Callable[[str], Awaitable[None]],
    send_bytes: Callable[[bytes], Awaitable[None]],
    payload: dict[str, Any],
    attachments: Sequence[Attachment] = (),
) -> None:
    """Send one packet; concurrent senders must share a lock around this call."""
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    metadata = [
        {"id": item.id, "name": item.name, "mimeType": item.mimeType, "size": len(item.data)}
        for item in attachments
    ]
    await send_text(json.dumps({"type": "packet", "payloadBytes": len(encoded), "attachments": metadata}))
    for data in (encoded, *(item.data for item in attachments)):
        for offset in range(0, len(data), CHUNK_BYTES):
            await send_bytes(data[offset : offset + CHUNK_BYTES])


async def receive_packet(
    receive: Callable[[], Awaitable[str | bytes]],
) -> tuple[dict[str, Any], list[Attachment]]:
    header = await receive()
    if not isinstance(header, str):
        raise ValueError("Expected a WebSocket packet header")
    envelope = json.loads(header)
    if not isinstance(envelope, dict) or envelope.get("type") != "packet":
        raise ValueError("Invalid WebSocket packet header")
    metadata = envelope.get("attachments", [])
    if not isinstance(metadata, list):
        raise ValueError("Invalid packet attachments")
    sizes = [envelope.get("payloadBytes"), *(item.get("size") for item in metadata)]
    if any(type(size) is not int or size < 0 for size in sizes):
        raise ValueError("Invalid packet byte length")
    identifiers = [item.get("id") for item in metadata]
    if any(not isinstance(item, str) or not item for item in identifiers) or len(set(identifiers)) != len(identifiers):
        raise ValueError("Packet attachment IDs must be unique nonempty strings")
    bodies = []
    for size in sizes:
        body = bytearray()
        while len(body) < size:
            chunk = await receive()
            if not isinstance(chunk, bytes) or not chunk or len(chunk) > CHUNK_BYTES:
                raise ValueError("Expected a bounded binary packet chunk")
            if len(body) + len(chunk) > size:
                raise ValueError("Packet chunk exceeds its declared byte length")
            body.extend(chunk)
        bodies.append(bytes(body))
    payload = json.loads(bodies[0].decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Packet payload must be an object")
    attachments = [Attachment(**item, data=data) for item, data in zip(metadata, bodies[1:], strict=True)]
    return payload, attachments
