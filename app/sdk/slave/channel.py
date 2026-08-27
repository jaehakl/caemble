from __future__ import annotations

import asyncio
import json
from typing import Any

from sdk.protocol.messages import DataChannelAttachment, DataChannelMessage

CHUNK_SIZE = 16 * 1024
INLINE_RESULT_CONTROL_BYTES = 32 * 1024
RESULT_PAYLOAD_SHARD_BYTES = 16 * 1024 * 1024
BUFFERED_AMOUNT_HIGH_WATER_MARK = 512 * 1024
BUFFERED_AMOUNT_LOW_THRESHOLD = 128 * 1024
BUFFERED_AMOUNT_DRAIN_TIMEOUT_SECONDS = 30


class JobResultControlFrameTooLarge(ValueError):
    pass


async def send_job_result(
    channel: Any,
    job_id: str,
    message: DataChannelMessage,
) -> tuple[int, int, int]:
    wire_payload = message.payload
    wire_attachments = list(message.attachments)
    frame = _job_result_frame(job_id, message.type, wire_payload, wire_attachments)
    control = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
    payload_attachment_bytes = 0

    if len(control.encode("utf-8")) > INLINE_RESULT_CONTROL_BYTES:
        payload_bytes = json.dumps(
            message.payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        payload_attachments = _result_payload_attachments(job_id, payload_bytes, wire_attachments)
        payload_attachment_bytes = len(payload_bytes)
        wire_attachments = [*payload_attachments, *wire_attachments]
        wire_payload = {
            "kind": "gpstation.job-result.payload-attachments",
            "storage": {
                "kind": "attachments",
                "ids": [attachment.id for attachment in payload_attachments],
                "byteLength": payload_attachment_bytes,
            },
        }
        frame = _job_result_frame(job_id, message.type, wire_payload, wire_attachments)
        control = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))

    control_bytes = len(control.encode("utf-8"))
    if control_bytes > INLINE_RESULT_CONTROL_BYTES:
        raise JobResultControlFrameTooLarge(
            f"job result control frame is {control_bytes} bytes after payload attachment fallback; "
            f"limit is {INLINE_RESULT_CONTROL_BYTES} bytes"
        )

    channel.send(control)
    for attachment in wire_attachments:
        await send_attachment(channel, job_id, attachment)
    drain_started_at = asyncio.get_running_loop().time()
    await wait_for_buffered_amount(channel, 0, "after job result")
    return (
        round((asyncio.get_running_loop().time() - drain_started_at) * 1000),
        control_bytes,
        payload_attachment_bytes,
    )


def _job_result_frame(
    job_id: str,
    message_type: str,
    payload: Any,
    attachments: list[DataChannelAttachment],
) -> dict[str, Any]:
    return {
        "kind": "job.result",
        "id": job_id,
        "type": message_type,
        "payload": payload,
        "attachments": [attachment_metadata(attachment) for attachment in attachments],
    }


def _result_payload_attachments(
    job_id: str,
    payload: bytes,
    existing: list[DataChannelAttachment],
) -> list[DataChannelAttachment]:
    existing_ids = {attachment.id for attachment in existing}
    count = max(1, (len(payload) + RESULT_PAYLOAD_SHARD_BYTES - 1) // RESULT_PAYLOAD_SHARD_BYTES)
    attachments: list[DataChannelAttachment] = []
    for index in range(count):
        attachment_id = f"gpstation-job-result-payload-{job_id}-{index}"
        while attachment_id in existing_ids:
            attachment_id = f"{attachment_id}-transport"
        existing_ids.add(attachment_id)
        attachments.append(
            DataChannelAttachment(
                id=attachment_id,
                name=f"job-result-payload.{index + 1:04d}-of-{count:04d}.json",
                mimeType="application/json; charset=utf-8",
                data=payload[
                    index * RESULT_PAYLOAD_SHARD_BYTES : (index + 1) * RESULT_PAYLOAD_SHARD_BYTES
                ],
            )
        )
    return attachments


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
        if getattr(channel, "bufferedAmount", 0) > BUFFERED_AMOUNT_HIGH_WATER_MARK:
            await wait_for_buffered_amount(channel, BUFFERED_AMOUNT_LOW_THRESHOLD, "while sending attachment")
        index += 1


async def wait_for_buffered_amount(channel: Any, threshold: int, phase: str) -> None:
    channel.bufferedAmountLowThreshold = threshold
    deadline = asyncio.get_running_loop().time() + BUFFERED_AMOUNT_DRAIN_TIMEOUT_SECONDS
    while getattr(channel, "bufferedAmount", 0) > threshold:
        if getattr(channel, "readyState", "open") != "open":
            raise RuntimeError(f"DataChannel closed {phase}")
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise TimeoutError(f"DataChannel buffer did not drain {phase}")
        await asyncio.sleep(min(0.01, remaining))


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
    header_length = int.from_bytes(frame[:4], "big")
    header = json.loads(frame[4 : 4 + header_length].decode("utf-8"))
    return header, frame[4 + header_length :]
