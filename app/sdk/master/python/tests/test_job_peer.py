from __future__ import annotations

import asyncio
import json

import pytest

from gpstation_master import GpStationError
from gpstation_master.binary import decode_binary_frame, encode_binary_frame
from gpstation_master.job_peer import GpStationJobPeer
from gpstation_master.types import RequestAttachment
from tests.fakes import FakeDataChannel, FakePeerConnection, wait_for_sent


@pytest.fixture
async def peer_parts() -> tuple[FakePeerConnection, FakeDataChannel, GpStationJobPeer]:
    peer_connection = FakePeerConnection()
    data_channel = FakeDataChannel()
    return peer_connection, data_channel, GpStationJobPeer(peer_connection, data_channel)


async def test_call_dispatches_event_and_acknowledges_result(
    peer_parts: tuple[FakePeerConnection, FakeDataChannel, GpStationJobPeer],
) -> None:
    _, channel, peer = peer_parts
    events = []
    call = asyncio.create_task(
        peer.call("job-1", "ai.chat", {"prompt": "hello"}, 1, events.append)
    )
    await wait_for_sent(channel, 1)

    channel.dispatch_message(
        json.dumps(
            {
                "kind": "job.event",
                "id": "job-1",
                "type": "ai.chat.delta",
                "payload": {"delta": "안녕"},
            },
            ensure_ascii=False,
        )
    )
    channel.dispatch_message(
        json.dumps({"kind": "job.result", "id": "job-1", "payload": {"answer": "안녕"}})
    )

    result = await call
    assert result.payload == {"answer": "안녕"}
    assert result.files == []
    assert events[0].payload == {"delta": "안녕"}
    assert json.loads(channel.sent[-1]) == {"kind": "job.result.ack", "id": "job-1"}
    await peer.close()


async def test_call_sends_attachment_metadata_and_ordered_chunks(
    peer_parts: tuple[FakePeerConnection, FakeDataChannel, GpStationJobPeer],
) -> None:
    _, channel, peer = peer_parts
    data = bytes(index % 251 for index in range(16 * 1024 + 3))
    call = asyncio.create_task(
        peer.call(
            "job-1",
            "ai.sdxl.i2i",
            {"prompts": ["hello"]},
            1,
            attachments=[
                RequestAttachment(id="image", data=data, name="input.png", mime_type="image/png")
            ],
        )
    )
    await wait_for_sent(channel, 3)

    control = json.loads(channel.sent[0])
    assert control["attachments"] == [
        {"id": "image", "size": len(data), "name": "input.png", "mimeType": "image/png"}
    ]
    chunks = [decode_binary_frame(item) for item in channel.sent[1:3]]
    assert [item[0]["index"] for item in chunks] == [0, 1]
    assert [item[0]["final"] for item in chunks] == [False, True]
    assert b"".join(item[1] for item in chunks) == data

    channel.dispatch_message(json.dumps({"kind": "job.result", "id": "job-1", "payload": True}))
    assert (await call).payload is True
    await peer.close()


async def test_call_waits_for_attachment_backpressure(
    peer_parts: tuple[FakePeerConnection, FakeDataChannel, GpStationJobPeer],
) -> None:
    _, channel, peer = peer_parts
    channel.bufferedAmount = 512 * 1024 + 1
    call = asyncio.create_task(
        peer.call(
            "job-1",
            "ai.sdxl.i2i",
            {},
            1,
            attachments=[RequestAttachment(id="image", data=b"x")],
        )
    )
    await wait_for_sent(channel, 2)
    assert channel.bufferedAmountLowThreshold == 128 * 1024
    channel.bufferedAmount = 0
    channel.dispatch_message(json.dumps({"kind": "job.result", "id": "job-1", "payload": None}))
    assert (await call).payload is None
    await peer.close()


async def test_call_receives_ordered_attachment_chunks(
    peer_parts: tuple[FakePeerConnection, FakeDataChannel, GpStationJobPeer],
) -> None:
    _, channel, peer = peer_parts
    call = asyncio.create_task(peer.call("job-1", "ai.image", {}, 1))
    await wait_for_sent(channel, 1)
    channel.dispatch_message(
        json.dumps(
            {
                "kind": "job.result",
                "id": "job-1",
                "payload": {"ok": True},
                "attachments": [
                    {"id": "output", "name": "result.bin", "mimeType": "application/octet-stream", "size": 3}
                ],
            }
        )
    )
    channel.dispatch_message(
        encode_binary_frame(
            {"kind": "attachment.chunk", "callId": "job-1", "attachmentId": "output", "index": 0, "final": False},
            b"ab",
        )
    )
    channel.dispatch_message(
        encode_binary_frame(
            {"kind": "attachment.chunk", "callId": "job-1", "attachmentId": "output", "index": 1, "final": True},
            b"c",
        )
    )

    result = await call
    assert result.files[0].data == b"abc"
    assert result.files[0].mime_type == "application/octet-stream"
    await peer.close()


async def test_call_rejects_duplicate_request_attachment_ids(
    peer_parts: tuple[FakePeerConnection, FakeDataChannel, GpStationJobPeer],
) -> None:
    _, channel, peer = peer_parts
    with pytest.raises(ValueError, match="duplicate request attachment id"):
        await peer.call(
            "job-1",
            "ai.image",
            {},
            1,
            attachments=[RequestAttachment(id="image", data=b"1"), RequestAttachment(id="image", data=b"2")],
        )
    assert channel.sent == []
    await peer.close()


async def test_call_rejects_out_of_order_result_chunk(
    peer_parts: tuple[FakePeerConnection, FakeDataChannel, GpStationJobPeer],
) -> None:
    _, channel, peer = peer_parts
    call = asyncio.create_task(peer.call("job-1", "ai.image", {}, 1))
    await wait_for_sent(channel, 1)
    channel.dispatch_message(
        json.dumps(
            {
                "kind": "job.result",
                "id": "job-1",
                "attachments": [{"id": "output", "size": 1}],
            }
        )
    )
    channel.dispatch_message(
        encode_binary_frame(
            {"kind": "attachment.chunk", "callId": "job-1", "attachmentId": "output", "index": 1, "final": True},
            b"x",
        )
    )

    with pytest.raises(Exception, match="out-of-order attachment chunk"):
        await call
    await peer.close()


async def test_finish_closes_after_finished_ack(
    peer_parts: tuple[FakePeerConnection, FakeDataChannel, GpStationJobPeer],
) -> None:
    peer_connection, channel, peer = peer_parts
    finish = asyncio.create_task(peer.finish("job-1", 1))
    await wait_for_sent(channel, 1)
    channel.dispatch_message(json.dumps({"kind": "job.finished", "id": "job-1"}))

    await finish
    assert json.loads(channel.sent[0]) == {"kind": "job.finish", "id": "job-1"}
    assert peer_connection.signalingState == "closed"


async def test_finish_resolves_when_channel_closes_after_frame_is_sent(
    peer_parts: tuple[FakePeerConnection, FakeDataChannel, GpStationJobPeer],
) -> None:
    peer_connection, channel, peer = peer_parts
    finish = asyncio.create_task(peer.finish("job-1", 1))
    await wait_for_sent(channel, 1)
    channel.close()

    await finish
    assert peer_connection.signalingState == "closed"


async def test_call_rejects_when_channel_errors(
    peer_parts: tuple[FakePeerConnection, FakeDataChannel, GpStationJobPeer],
) -> None:
    _, channel, peer = peer_parts
    call = asyncio.create_task(peer.call("job-1", "ai.llm", {}, 1))
    await wait_for_sent(channel, 1)
    channel.emit("error", RuntimeError("transport failed"))

    with pytest.raises(GpStationError, match="data channel error"):
        await call
    await peer.close()


async def test_call_times_out_without_result(
    peer_parts: tuple[FakePeerConnection, FakeDataChannel, GpStationJobPeer],
) -> None:
    _, _, peer = peer_parts
    with pytest.raises(TimeoutError, match="job result timeout"):
        await peer.call("job-1", "ai.llm", {}, 0.01)
    await peer.close()


async def test_cancelled_call_closes_peer(
    peer_parts: tuple[FakePeerConnection, FakeDataChannel, GpStationJobPeer],
) -> None:
    peer_connection, channel, peer = peer_parts
    call = asyncio.create_task(peer.call("job-1", "ai.llm", {}, 10))
    await wait_for_sent(channel, 1)
    call.cancel()

    with pytest.raises(asyncio.CancelledError):
        await call
    assert peer_connection.signalingState == "closed"
