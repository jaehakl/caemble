from __future__ import annotations

import asyncio
import json
from typing import Any

from sdk.protocol.messages import DataChannelAttachment, DataChannelMessage

CHUNK_SIZE = 16 * 1024
MAX_BUFFERED_AMOUNT = 512 * 1024
BUFFERED_AMOUNT_LOW_THRESHOLD = 128 * 1024
BUFFERED_AMOUNT_DRAIN_TIMEOUT_SECONDS = 30


async def send_job_result(channel: Any, job_id: str, message: DataChannelMessage) -> None:
    attachments = [attachment_metadata(attachment) for attachment in message.attachments]
    channel.send(
        json.dumps(
            {
                "kind": "job.result",
                "id": job_id,
                "type": message.type,
                "payload": message.payload,
                "attachments": attachments,
            },
            ensure_ascii=False,
        )
    )
    for attachment in message.attachments:
        await send_attachment(channel, job_id, attachment)


async def send_attachment(channel: Any, call_id: str, attachment: DataChannelAttachment) -> None:
    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD
    data = attachment.data
    if not data:
        channel.send(
            encode_binary_frame(
                {
                    "kind": "attachment.chunk",
                    "callId": call_id,
                    "attachmentId": attachment.id,
                    "index": 0,
                    "final": True,
                },
                b"",
            )
        )
        return
    index = 0
    for offset in range(0, len(data), CHUNK_SIZE):
        chunk = data[offset : offset + CHUNK_SIZE]
        final = offset + CHUNK_SIZE >= len(data)
        channel.send(
            encode_binary_frame(
                {
                    "kind": "attachment.chunk",
                    "callId": call_id,
                    "attachmentId": attachment.id,
                    "index": index,
                    "final": final,
                },
                chunk,
            )
        )
        if getattr(channel, "bufferedAmount", 0) > MAX_BUFFERED_AMOUNT:
            deadline = asyncio.get_running_loop().time() + BUFFERED_AMOUNT_DRAIN_TIMEOUT_SECONDS
            while getattr(channel, "bufferedAmount", 0) > BUFFERED_AMOUNT_LOW_THRESHOLD:
                if getattr(channel, "readyState", "open") != "open":
                    raise RuntimeError("DataChannel closed while sending attachment")
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise TimeoutError("DataChannel buffer did not drain while sending attachment")
                await asyncio.sleep(min(0.01, remaining))
        index += 1


def attachment_metadata(attachment: DataChannelAttachment) -> dict[str, Any]:
    metadata: dict[str, Any] = {"id": attachment.id, "size": attachment.size or len(attachment.data)}
    if attachment.name is not None:
        metadata["name"] = attachment.name
    if attachment.mimeType is not None:
        metadata["mimeType"] = attachment.mimeType
    return metadata


def encode_binary_frame(header: dict[str, Any], body: bytes) -> bytes:
    header_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return len(header_bytes).to_bytes(4, "big") + header_bytes + body


def decode_binary_frame(frame: bytes) -> tuple[dict[str, Any], bytes]:
    if len(frame) < 4:
        raise ValueError("binary frame is too short")
    header_length = int.from_bytes(frame[:4], "big")
    if header_length <= 0 or len(frame) < 4 + header_length:
        raise ValueError("invalid binary frame header length")
    header = json.loads(frame[4 : 4 + header_length].decode("utf-8"))
    if not isinstance(header, dict):
        raise ValueError("binary frame header must be an object")
    return header, frame[4 + header_length :]
