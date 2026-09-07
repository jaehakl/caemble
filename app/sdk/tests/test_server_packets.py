from __future__ import annotations

import asyncio
import json

import pytest

from sdk.protocol.messages import JobStart, LauncherHello
from sdk.protocol.packets import Attachment, CHUNK_BYTES, receive_packet, send_packet


@pytest.mark.asyncio
async def test_packet_preserves_large_unicode_payload_and_binary_attachments() -> None:
    frames = asyncio.Queue()
    payload = {"type": "job.record", "value": "한글" * 100000}
    attachment = Attachment(id="field", data=bytes(range(256)) * 3000)
    await send_packet(frames.put, frames.put, payload, [attachment])
    assert all(not isinstance(frame, bytes) or len(frame) <= CHUNK_BYTES for frame in frames._queue)
    actual, attachments = await receive_packet(frames.get)
    assert actual == payload
    assert attachments[0].data == attachment.data
    assert frames.empty()


@pytest.mark.asyncio
@pytest.mark.parametrize("chunk", [b"too long", "unexpected text", b""])
async def test_packet_rejects_corrupt_binary_sequence(chunk) -> None:
    frames = asyncio.Queue()
    await frames.put(json.dumps({"type": "packet", "payloadBytes": 2, "attachments": []}))
    await frames.put(chunk)
    with pytest.raises(ValueError):
        await receive_packet(frames.get)


def test_webrtc_assignment_remains_default_and_server_mode_is_explicit() -> None:
    legacy = JobStart(type="job.start", job_id="job", handler_type="ai.test", slave_app_id="ai", offer={"type": "offer", "sdp": "sdp"})
    assert legacy.job_mode == "webrtc"
    assert LauncherHello(type="launcher.hello", launcher_name="legacy").job_modes == {}
    with pytest.raises(ValueError, match="require an offer"):
        JobStart(type="job.start", job_id="job", handler_type="ai.test", slave_app_id="ai")
    server = JobStart(type="job.start", job_id="job", handler_type="cae", slave_app_id="cae", job_mode="websocket", websocket_url="ws://localhost/job", token="token", attempt_count=1)
    assert server.offer is None
