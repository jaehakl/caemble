from __future__ import annotations

import json
from typing import Any

import numpy as np
import pytest

from app.tensor import encode_recorded_data
from sdk.protocol.messages import DataChannelAttachment, DataChannelMessage
from sdk.slave.app import SlaveApp, SlaveContext
from sdk.slave.channel import (
    INLINE_RESULT_CONTROL_BYTES,
    JobResultControlFrameTooLarge,
    decode_binary_frame,
    send_job_result,
)
from sdk.slave.worker import WorkerJobPeerState, run_worker_job_call


class FakeDataChannel:
    def __init__(self) -> None:
        self.readyState = "open"
        self.bufferedAmount = 0
        self.bufferedAmountLowThreshold = 0
        self.sent: list[str | bytes] = []

    def send(self, value: str | bytes) -> None:
        self.sent.append(value)


@pytest.mark.asyncio
async def test_small_job_result_keeps_inline_wire_shape() -> None:
    channel = FakeDataChannel()
    message = DataChannelMessage(id="result", type="example.result", payload={"ok": True})

    drain_ms, control_bytes, payload_attachment_bytes = await send_job_result(
        channel, "call-1", message
    )

    assert drain_ms >= 0
    assert control_bytes <= INLINE_RESULT_CONTROL_BYTES
    assert payload_attachment_bytes == 0
    assert len(channel.sent) == 1
    frame = json.loads(channel.sent[0])
    assert frame == {
        "kind": "job.result",
        "id": "call-1",
        "type": "example.result",
        "payload": {"ok": True},
        "attachments": [],
    }


@pytest.mark.asyncio
async def test_fdtd_time_field_payload_uses_transport_attachment() -> None:
    rng = np.random.default_rng(1)
    field = np.zeros((91, 4, 4, 2, 3), dtype=np.float32)
    field[..., 2] = rng.standard_normal(field.shape[:-1]).astype(np.float32)
    ticks = [
        {"name": "time", "unit": "s", "ticks": np.linspace(0, 15e-15, 91)},
        {"name": "z", "unit": "m", "ticks": np.array([-0.3e-6, -0.1e-6, 0.1e-6, 0.3e-6])},
        {"name": "y", "unit": "m", "ticks": np.array([-0.3e-6, -0.1e-6, 0.1e-6, 0.3e-6])},
        {"name": "x", "unit": "m", "ticks": np.array([0.65e-6, 0.85e-6])},
    ]
    encoded, attachments, _ = encode_recorded_data(
        "timeElectricField",
        {"field": {"dtype": "float32"}},
        {"field": {"value": field, "axes": ticks}},
        1,
    )
    payload = {
        "kind": "record",
        "sequence": 1,
        "name": "timeElectricField",
        "value": encoded,
    }
    inline_bytes = len(
        json.dumps(
            {
                "kind": "job.result",
                "id": "call-2",
                "type": "cae.simulation.next.result",
                "payload": payload,
                "attachments": [],
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    assert not attachments
    assert isinstance(encoded["field"]["axes"][0]["ticks"], list)
    assert inline_bytes > 65_536

    channel = FakeDataChannel()
    user_attachment = DataChannelAttachment(
        id="gpstation-job-result-payload-call-2-0",
        name="sidecar.bin",
        mimeType="application/octet-stream",
        data=b"sidecar",
    )
    message = DataChannelMessage(
        id="result",
        type="cae.simulation.next.result",
        payload=payload,
        attachments=[user_attachment],
    )

    _, control_bytes, payload_attachment_bytes = await send_job_result(channel, "call-2", message)

    assert control_bytes <= INLINE_RESULT_CONTROL_BYTES < 65_536
    assert payload_attachment_bytes > 65_536
    control = json.loads(channel.sent[0])
    assert control["payload"]["kind"] == "gpstation.job-result.payload-attachments"
    payload_ids = control["payload"]["storage"]["ids"]
    received: dict[str, list[tuple[int, bool, bytes]]] = {}
    for raw in channel.sent[1:]:
        header, body = decode_binary_frame(raw)
        received.setdefault(header["attachmentId"], []).append(
            (header["index"], header["final"], body)
        )
    for attachment_id, chunks in received.items():
        assert [index for index, _, _ in chunks] == list(range(len(chunks)))
        assert [final for _, final, _ in chunks] == [False] * (len(chunks) - 1) + [True]
        assert attachment_id in {item["id"] for item in control["attachments"]}
    restored_payload = json.loads(
        b"".join(body for attachment_id in payload_ids for _, _, body in received[attachment_id])
    )
    assert restored_payload == payload
    assert (
        b"".join(
            body
            for _, _, body in received["gpstation-job-result-payload-call-2-0"]
        )
        == b"sidecar"
    )


@pytest.mark.asyncio
async def test_job_result_rejects_oversized_attachment_manifest_before_send() -> None:
    channel = FakeDataChannel()
    attachments = [
        DataChannelAttachment(
            id=f"attachment-{index}",
            name=f"{'x' * 120}-{index}.bin",
            data=b"",
        )
        for index in range(300)
    ]
    message = DataChannelMessage(
        id="result",
        type="example.result",
        payload={"value": "x" * 40_000},
        attachments=attachments,
    )

    with pytest.raises(JobResultControlFrameTooLarge, match="after payload attachment fallback"):
        await send_job_result(channel, "call-3", message)

    assert channel.sent == []


@pytest.mark.asyncio
async def test_worker_returns_job_error_when_result_manifest_cannot_fit() -> None:
    channel = FakeDataChannel()
    app = SlaveApp()

    @app.handler("large-result")
    async def large_result(*_: Any) -> DataChannelMessage:
        return DataChannelMessage(
            id="result",
            type="large-result.result",
            payload={"value": "x" * 40_000},
            attachments=[
                DataChannelAttachment(
                    id=f"attachment-{index}",
                    name=f"{'x' * 120}-{index}.bin",
                    data=b"",
                )
                for index in range(300)
            ],
        )

    await run_worker_job_call(
        app,
        SlaveContext(session_id="test", ttl_seconds=10),
        channel,
        WorkerJobPeerState(),
        {"id": "call-4", "type": "large-result", "payload": None},
    )

    assert len(channel.sent) == 1
    error = json.loads(channel.sent[0])
    assert error["kind"] == "job.error"
    assert error["id"] == "call-4"
    assert error["code"] == "job_result_control_frame_too_large"
    assert "after payload attachment fallback" in error["detail"]
