from __future__ import annotations

import asyncio
import json
import sys
from io import BytesIO

import pytest
import sdk.slave.channel as channel_module
import sdk.slave.worker as worker_module

from sdk.protocol.constants import DATA_CHANNEL_LABEL
from sdk.slave import DataChannelAttachment, DataChannelMessage, SlaveApp, SlaveContext
from sdk.slave.runtime import (
    BUFFERED_AMOUNT_LOW_THRESHOLD,
    CHUNK_SIZE,
    JOB_DATA_CHANNEL_ATTACHMENT_MAX_BYTES,
    JOB_DATA_CHANNEL_MESSAGE_MAX_BYTES,
    MAX_BUFFERED_AMOUNT,
    attach_worker_job_peer_handlers,
    configure_aioice_gather_timeout,
    emit,
    encode_binary_frame,
    load_rtc_ice_gather_timeout_seconds,
    load_rtc_memory_cache_enabled,
    load_rtc_ice_servers,
    parse_job_ready_message,
    prepare_worker_peer,
    read_stdin_line,
    send_job_result,
    summarize_sdp_candidates,
    wait_for_job_result_ack,
)


class DummyChannel:
    label = DATA_CHANNEL_LABEL

    def __init__(self) -> None:
        self.sent: list[str | bytes] = []

    def send(self, message: str | bytes) -> None:
        self.sent.append(message)


class FakeDataChannel:
    label = DATA_CHANNEL_LABEL

    def __init__(self) -> None:
        self.sent: list[str | bytes] = []
        self.handlers = {}

    def on(self, name):
        def decorator(func):
            self.handlers[name] = func
            return func

        return decorator

    def send(self, message: str | bytes) -> None:
        self.sent.append(message)


class FakePeerConnection:
    connectionState = "connected"

    def __init__(self) -> None:
        self.handlers = {}

    def on(self, name):
        def decorator(func):
            self.handlers[name] = func
            return func

        return decorator


class FakeAioIceConnection:
    observed_timeouts: list[float] = []

    async def get_component_candidates(self, component: int, addresses: list[str], timeout: float = 5):
        FakeAioIceConnection.observed_timeouts.append(timeout)
        return []


class FakeCandidate:
    def __init__(self, candidate_type: str) -> None:
        self.type = candidate_type


class FakeGatherer:
    gathered = False

    async def gather(self):
        FakeGatherer.gathered = True

    def getLocalCandidates(self):
        return [FakeCandidate("host"), FakeCandidate("srflx")]


class FakeIceTransport:
    def __init__(self) -> None:
        self.iceGatherer = FakeGatherer()


class FakePreparedPeerConnection:
    closed = False
    created = False

    def __init__(self, configuration) -> None:
        self.configuration = configuration
        FakePreparedPeerConnection.created = True
        FakePreparedPeerConnection.closed = False
        FakeGatherer.gathered = False
        setattr(self, "_RTCPeerConnection__iceTransports", set())

    def _RTCPeerConnection__createSctpTransport(self) -> None:
        getattr(self, "_RTCPeerConnection__iceTransports").add(FakeIceTransport())

    async def close(self) -> None:
        FakePreparedPeerConnection.closed = True


def test_handler_decorators_preserve_registration_order():
    app = SlaveApp(memory={})

    @app.handler("first")
    def first(message, memory, context):
        return None

    @app.handler("second")
    def second(message, memory, context):
        return None

    assert [handler.message_type for handler in app.handlers] == ["first", "second"]


def test_load_rtc_ice_servers_uses_default_stun(monkeypatch):
    monkeypatch.delenv("GPSTATION_V1_RTC_ICE_SERVERS_JSON", raising=False)

    assert load_rtc_ice_servers() == [{"urls": "stun:stun.l.google.com:19302"}]


def test_load_rtc_ice_servers_accepts_turn_credentials(monkeypatch):
    monkeypatch.setenv(
        "GPSTATION_V1_RTC_ICE_SERVERS_JSON",
        json.dumps(
            [
                {"urls": ["stun:stun.example.com:3478"]},
                {
                    "urls": "turn:turn.example.com:3478",
                    "username": "user",
                    "credential": "password",
                },
            ]
        ),
    )

    assert load_rtc_ice_servers() == [
        {"urls": ["stun:stun.example.com:3478"]},
        {"urls": "turn:turn.example.com:3478", "username": "user", "credential": "password"},
    ]


def test_load_rtc_ice_servers_rejects_invalid_json(monkeypatch):
    monkeypatch.setenv("GPSTATION_V1_RTC_ICE_SERVERS_JSON", "{not-json")

    with pytest.raises(ValueError, match="valid JSON"):
        load_rtc_ice_servers()


def test_load_rtc_ice_gather_timeout_defaults_to_one_second_for_stun_only(monkeypatch):
    monkeypatch.delenv("GPSTATION_V1_RTC_ICE_GATHER_TIMEOUT_SECONDS", raising=False)

    timeout = load_rtc_ice_gather_timeout_seconds([{"urls": "stun:stun.example.com:3478"}])

    assert timeout == 1.0


def test_load_rtc_ice_gather_timeout_defaults_to_five_seconds_for_turn(monkeypatch):
    monkeypatch.delenv("GPSTATION_V1_RTC_ICE_GATHER_TIMEOUT_SECONDS", raising=False)

    timeout = load_rtc_ice_gather_timeout_seconds(
        [{"urls": ["stun:stun.example.com:3478", "turn:turn.example.com:3478"]}]
    )

    assert timeout == 5.0


def test_load_rtc_ice_gather_timeout_uses_explicit_env(monkeypatch):
    monkeypatch.setenv("GPSTATION_V1_RTC_ICE_GATHER_TIMEOUT_SECONDS", "2.5")

    timeout = load_rtc_ice_gather_timeout_seconds([{"urls": "turn:turn.example.com:3478"}])

    assert timeout == 2.5


@pytest.mark.parametrize("value", ["0", "-1", "abc"])
def test_load_rtc_ice_gather_timeout_rejects_invalid_env(monkeypatch, value):
    monkeypatch.setenv("GPSTATION_V1_RTC_ICE_GATHER_TIMEOUT_SECONDS", value)

    with pytest.raises(ValueError, match="positive number"):
        load_rtc_ice_gather_timeout_seconds([{"urls": "stun:stun.example.com:3478"}])


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("", True),
        ("true", True),
        ("1", True),
        ("false", False),
        ("0", False),
    ],
)
def test_load_rtc_memory_cache_enabled(monkeypatch, value, expected):
    if value:
        monkeypatch.setenv("GPSTATION_V1_RTC_MEMORY_CACHE_ENABLED", value)
    else:
        monkeypatch.delenv("GPSTATION_V1_RTC_MEMORY_CACHE_ENABLED", raising=False)

    assert load_rtc_memory_cache_enabled() is expected


def test_load_rtc_memory_cache_enabled_rejects_invalid_env(monkeypatch):
    monkeypatch.setenv("GPSTATION_V1_RTC_MEMORY_CACHE_ENABLED", "maybe")

    with pytest.raises(ValueError, match="true or false"):
        load_rtc_memory_cache_enabled()


@pytest.mark.asyncio
async def test_configure_aioice_gather_timeout_patches_default_timeout():
    FakeAioIceConnection.observed_timeouts = []

    configure_aioice_gather_timeout(FakeAioIceConnection, 1.25)
    await FakeAioIceConnection().get_component_candidates(component=1, addresses=["10.0.0.2"])

    assert FakeAioIceConnection.observed_timeouts == [1.25]


@pytest.mark.asyncio
async def test_prepare_worker_peer_keeps_live_gathered_peer(capsys):
    configuration = object()

    prepared = await prepare_worker_peer(FakePreparedPeerConnection, configuration, label="test")

    assert prepared.pc.configuration is configuration
    assert FakePreparedPeerConnection.created is True
    assert FakePreparedPeerConnection.closed is False
    assert FakeGatherer.gathered is True
    captured = capsys.readouterr()
    assert "test ICE memory cache prepared" in captured.err
    assert "srflx=1" in captured.err


def test_summarize_sdp_candidates_counts_candidate_types():
    summary = summarize_sdp_candidates(
        "\r\n".join(
            [
                "v=0",
                "a=candidate:1 1 udp 1 10.0.0.2 5000 typ host",
                "a=candidate:2 1 udp 1 203.0.113.2 5001 typ srflx",
                "a=candidate:3 1 udp 1 198.51.100.2 5002 typ relay",
                "a=candidate:4 1 udp 1 198.51.100.3 5003 typ prflx",
                "a=candidate:5 1 udp 1 198.51.100.4 5004",
            ]
        )
    )

    assert summary == {"host": 1, "srflx": 1, "relay": 1, "prflx": 1, "unknown": 1, "total": 5}


@pytest.mark.asyncio
async def test_send_job_result_uses_job_result_envelope():
    channel = DummyChannel()

    await send_job_result(
        channel,
        "job-1",
        DataChannelMessage(id="job-1", type="ai.llm.result", payload={"text": "hello"}),
    )

    assert json.loads(channel.sent[0]) == {
        "kind": "job.result",
        "id": "job-1",
        "type": "ai.llm.result",
        "payload": {"text": "hello"},
        "attachments": [],
    }


def test_read_stdin_line_decodes_utf8_bytes(monkeypatch):
    class FakeStdin:
        buffer = BytesIO(json.dumps({"prompt": "한글"}, ensure_ascii=False).encode("utf-8") + b"\n")

    monkeypatch.setattr(sys, "stdin", FakeStdin())

    line = read_stdin_line()

    assert json.loads(line)["prompt"] == "한글"


def test_emit_writes_utf8_json_line(monkeypatch):
    class FakeStdout:
        def __init__(self) -> None:
            self.buffer = BytesIO()

    stdout = FakeStdout()
    monkeypatch.setattr(sys, "stdout", stdout)

    emit({"type": "test", "payload": "한글"})

    output = stdout.buffer.getvalue()
    assert "한글".encode("utf-8") in output
    assert json.loads(output.decode("utf-8")) == {"type": "test", "payload": "한글"}


def test_parse_job_ready_message_extracts_input_payload():
    is_ready, input_payload, error = parse_job_ready_message(
        json.dumps({"kind": "job.ready", "id": "job-1", "input": {"text": "한글"}}),
        "job-1",
    )

    assert is_ready is True
    assert input_payload == {"text": "한글"}
    assert error is None


def test_parse_job_ready_message_rejects_wrong_job_id():
    is_ready, input_payload, error = parse_job_ready_message(
        json.dumps({"kind": "job.ready", "id": "other", "input": {"text": "hello"}}),
        "job-1",
    )

    assert is_ready is True
    assert input_payload is None
    assert error == "job.ready id mismatch: expected job-1, got other"


def test_parse_job_ready_message_reports_malformed_frame():
    is_ready, input_payload, error = parse_job_ready_message("{not-json", "job-1")

    assert is_ready is True
    assert input_payload is None
    assert error is not None
    assert "malformed job.ready frame" in error


def test_parse_job_ready_message_rejects_oversized_frame():
    is_ready, input_payload, error = parse_job_ready_message(
        "x" * (JOB_DATA_CHANNEL_MESSAGE_MAX_BYTES + 1),
        "job-1",
    )

    assert is_ready is True
    assert input_payload is None
    assert "exceeds" in error


def test_datachannel_ready_then_call_enqueues_call():
    pc = FakePeerConnection()
    state = attach_worker_job_peer_handlers(pc, "job-1", "ai.llm", 0.0)
    channel = FakeDataChannel()

    pc.handlers["datachannel"](channel)
    channel.handlers["message"](json.dumps({"kind": "job.ready", "id": "job-1"}))
    channel.handlers["message"](
        json.dumps({"kind": "job.call", "id": "call-1", "type": "ai.embeddings", "payload": {"text": "hello"}})
    )

    assert state.ready_event.is_set()
    assert state.call_queue.get_nowait() == {
        "id": "call-1",
        "type": "ai.embeddings",
        "payload": {"text": "hello"},
    }


def test_datachannel_assembles_request_attachment_before_enqueuing_call():
    pc = FakePeerConnection()
    state = attach_worker_job_peer_handlers(pc, "job-1", "ai.sdxl.i2i", 0.0)
    channel = FakeDataChannel()

    pc.handlers["datachannel"](channel)
    channel.handlers["message"](json.dumps({"kind": "job.ready", "id": "job-1"}))
    channel.handlers["message"](
        json.dumps(
            {
                "kind": "job.call",
                "id": "call-1",
                "type": "ai.sdxl.i2i",
                "payload": {"prompts": ["hello"]},
                "attachments": [{"id": "image", "name": "input.png", "mimeType": "image/png", "size": 5}],
            }
        )
    )

    assert state.call_queue.empty()
    channel.handlers["message"](
        encode_binary_frame(
            {"kind": "attachment.chunk", "callId": "call-1", "attachmentId": "image", "index": 0, "final": False},
            b"hel",
        )
    )
    assert state.call_queue.empty()
    channel.handlers["message"](
        encode_binary_frame(
            {"kind": "attachment.chunk", "callId": "call-1", "attachmentId": "image", "index": 1, "final": True},
            b"lo",
        )
    )

    call = state.call_queue.get_nowait()
    assert call["id"] == "call-1"
    assert call["type"] == "ai.sdxl.i2i"
    assert call["payload"] == {"prompts": ["hello"]}
    assert len(call["attachments"]) == 1
    assert call["attachments"][0].id == "image"
    assert call["attachments"][0].mimeType == "image/png"
    assert call["attachments"][0].data == b"hello"


@pytest.mark.parametrize(
    ("attachments", "detail"),
    [
        ([{"id": "image", "size": 1}, {"id": "image", "size": 1}], "duplicate"),
        ([{"id": "image", "size": JOB_DATA_CHANNEL_ATTACHMENT_MAX_BYTES + 1}], "exceeds"),
    ],
)
def test_datachannel_rejects_invalid_request_attachment_metadata(attachments, detail):
    pc = FakePeerConnection()
    state = attach_worker_job_peer_handlers(pc, "job-1", "ai.sdxl.i2i", 0.0)
    channel = FakeDataChannel()

    pc.handlers["datachannel"](channel)
    channel.handlers["message"](json.dumps({"kind": "job.ready", "id": "job-1"}))
    channel.handlers["message"](
        json.dumps(
            {
                "kind": "job.call",
                "id": "call-1",
                "type": "ai.sdxl.i2i",
                "payload": {},
                "attachments": attachments,
            }
        )
    )

    error = json.loads(channel.sent[-1])
    assert error["code"] == "invalid_attachment"
    assert detail in error["detail"]
    assert state.incoming_call is None


@pytest.mark.parametrize(
    ("header", "body", "detail"),
    [
        (
            {"kind": "attachment.chunk", "callId": "call-1", "attachmentId": "unknown", "index": 0, "final": True},
            b"hello",
            "unknown",
        ),
        (
            {"kind": "attachment.chunk", "callId": "call-1", "attachmentId": "image", "index": 1, "final": True},
            b"hello",
            "out-of-order",
        ),
        (
            {"kind": "attachment.chunk", "callId": "call-1", "attachmentId": "image", "index": 0, "final": True},
            b"hey",
            "size mismatch",
        ),
    ],
)
def test_datachannel_rejects_invalid_request_attachment_chunks(header, body, detail):
    pc = FakePeerConnection()
    state = attach_worker_job_peer_handlers(pc, "job-1", "ai.sdxl.i2i", 0.0)
    channel = FakeDataChannel()

    pc.handlers["datachannel"](channel)
    channel.handlers["message"](json.dumps({"kind": "job.ready", "id": "job-1"}))
    channel.handlers["message"](
        json.dumps(
            {
                "kind": "job.call",
                "id": "call-1",
                "type": "ai.sdxl.i2i",
                "payload": {},
                "attachments": [{"id": "image", "size": 5}],
            }
        )
    )
    channel.handlers["message"](encode_binary_frame(header, body))

    error = json.loads(channel.sent[-1])
    assert error["code"] == "invalid_attachment"
    assert detail in error["detail"]
    assert state.incoming_call is None


def test_datachannel_legacy_ready_input_enqueues_first_call():
    pc = FakePeerConnection()
    state = attach_worker_job_peer_handlers(pc, "job-1", "ai.llm", 0.0)
    channel = FakeDataChannel()

    pc.handlers["datachannel"](channel)
    channel.handlers["message"](json.dumps({"kind": "job.ready", "id": "job-1", "input": {"prompt": "hello"}}))

    assert state.ready_event.is_set()
    assert state.call_queue.get_nowait() == {
        "id": "job-1",
        "type": "ai.llm",
        "payload": {"prompt": "hello"},
    }


def test_datachannel_rejects_overlapping_call():
    pc = FakePeerConnection()
    state = attach_worker_job_peer_handlers(pc, "job-1", "ai.llm", 0.0)
    channel = FakeDataChannel()

    pc.handlers["datachannel"](channel)
    channel.handlers["message"](json.dumps({"kind": "job.ready", "id": "job-1"}))
    channel.handlers["message"](json.dumps({"kind": "job.call", "id": "call-1", "type": "ai.llm"}))
    channel.handlers["message"](json.dumps({"kind": "job.call", "id": "call-2", "type": "ai.llm"}))

    assert state.call_queue.get_nowait()["id"] == "call-1"
    assert json.loads(channel.sent[0]) == {
        "kind": "job.error",
        "id": "call-2",
        "code": "worker_busy",
        "detail": "worker is already processing a job call",
    }


def test_datachannel_accepts_next_call_immediately_after_result_ack():
    pc = FakePeerConnection()
    state = attach_worker_job_peer_handlers(pc, "job-1", "ai.llm", 0.0)
    channel = FakeDataChannel()

    pc.handlers["datachannel"](channel)
    channel.handlers["message"](json.dumps({"kind": "job.ready", "id": "job-1"}))
    channel.handlers["message"](json.dumps({"kind": "job.call", "id": "call-1", "type": "ai.llm"}))
    assert state.call_queue.get_nowait()["id"] == "call-1"
    state.call_in_progress = True
    state.result_ack_events["call-1"] = asyncio.Event()

    channel.handlers["message"](json.dumps({"kind": "job.result.ack", "id": "call-1"}))
    channel.handlers["message"](json.dumps({"kind": "job.call", "id": "call-2", "type": "ai.llm"}))

    assert state.call_in_progress is False
    assert state.call_queue.get_nowait()["id"] == "call-2"
    assert channel.sent == []


def test_datachannel_ignores_unknown_result_ack_for_busy_state():
    pc = FakePeerConnection()
    state = attach_worker_job_peer_handlers(pc, "job-1", "ai.llm", 0.0)
    channel = FakeDataChannel()

    pc.handlers["datachannel"](channel)
    state.call_in_progress = True
    state.result_ack_events["call-1"] = asyncio.Event()

    channel.handlers["message"](json.dumps({"kind": "job.result.ack", "id": "unknown-call"}))

    assert state.call_in_progress is True
    assert not state.result_ack_events["call-1"].is_set()


def test_datachannel_rejects_oversized_binary_without_logging_contents(monkeypatch):
    pc = FakePeerConnection()
    state = attach_worker_job_peer_handlers(pc, "job-1", "ai.llm", 0.0)
    channel = FakeDataChannel()
    logs = []
    monkeypatch.setattr(worker_module, "log", logs.append)

    pc.handlers["datachannel"](channel)
    channel.handlers["message"](b"secret-marker" + b"x" * JOB_DATA_CHANNEL_MESSAGE_MAX_BYTES)

    assert state.ready_event.is_set()
    assert "exceeds" in state.ready_error["detail"]
    assert "secret-marker" not in "\n".join(logs)


@pytest.mark.asyncio
async def test_wait_for_job_result_ack_succeeds_when_ack_arrives():
    ack_event = asyncio.Event()
    closed_event = asyncio.Event()
    task = asyncio.create_task(wait_for_job_result_ack("job-1", ack_event, closed_event, timeout_seconds=1))

    await asyncio.sleep(0)
    ack_event.set()

    await task


@pytest.mark.asyncio
async def test_wait_for_job_result_ack_times_out():
    with pytest.raises(RuntimeError, match="result delivery ack timeout"):
        await wait_for_job_result_ack("job-1", asyncio.Event(), asyncio.Event(), timeout_seconds=0.01)


@pytest.mark.asyncio
async def test_wait_for_job_result_ack_fails_when_channel_closes_first():
    closed_event = asyncio.Event()
    closed_event.set()

    with pytest.raises(RuntimeError, match="closed before result delivery ack"):
        await wait_for_job_result_ack("job-1", asyncio.Event(), closed_event, timeout_seconds=1)


@pytest.mark.asyncio
async def test_initialize_hook_runs_with_memory_and_context():
    memory = {"initialized_for": None}
    app = SlaveApp(memory=memory)
    context = SlaveContext(session_id="session-1", ttl_seconds=60)

    @app.initialize
    async def initialize(memory, context):
        memory["initialized_for"] = context.session_id

    await app.run_initialize(context)

    assert memory["initialized_for"] == "session-1"


@pytest.mark.asyncio
async def test_slave_context_emit_event_uses_sender():
    events = []

    async def send_event(event_type, payload):
        events.append((event_type, payload))

    context = SlaveContext(session_id="session-1", ttl_seconds=60, call_id="call-1", _event_sender=send_event)

    await context.emit_event("token", {"text": "hello"})

    assert events == [("token", {"text": "hello"})]


@pytest.mark.asyncio
async def test_send_job_result_sends_attachment_chunks():
    channel = DummyChannel()
    data = bytes(index % 251 for index in range(CHUNK_SIZE + 3))

    await send_job_result(
        channel,
        "job-1",
        DataChannelMessage(
            id="job-1",
            type="file.result",
            payload={"ok": True},
            attachments=[
                DataChannelAttachment(
                    id="out-large",
                    name="large.bin",
                    mimeType="application/octet-stream",
                    data=data,
                )
            ],
        ),
    )

    response = json.loads(channel.sent[0])
    assert response == {
        "kind": "job.result",
        "id": "job-1",
        "type": "file.result",
        "payload": {"ok": True},
        "attachments": [
            {"id": "out-large", "size": len(data), "name": "large.bin", "mimeType": "application/octet-stream"}
        ],
    }

    chunks = []
    for index, message in enumerate(channel.sent[1:]):
        frame = bytes(message)
        header_length = int.from_bytes(frame[:4], "big")
        header = json.loads(frame[4 : 4 + header_length].decode("utf-8"))
        body = frame[4 + header_length :]
        assert header == {
            "kind": "attachment.chunk",
            "callId": "job-1",
            "attachmentId": "out-large",
            "index": index,
            "final": index == 1,
        }
        assert len(body) <= CHUNK_SIZE
        chunks.append(body)

    assert len(chunks) == 2
    assert b"".join(chunks) == data


@pytest.mark.asyncio
async def test_send_job_result_waits_for_datachannel_backpressure():
    channel = DummyChannel()
    channel.bufferedAmount = MAX_BUFFERED_AMOUNT + 1

    task = asyncio.create_task(
        send_job_result(
            channel,
            "job-1",
            DataChannelMessage(
                id="job-1",
                type="file.result",
                attachments=[DataChannelAttachment(id="out", data=b"payload")],
            ),
        )
    )
    await asyncio.sleep(0)

    assert not task.done()
    assert channel.bufferedAmountLowThreshold == BUFFERED_AMOUNT_LOW_THRESHOLD

    channel.bufferedAmount = BUFFERED_AMOUNT_LOW_THRESHOLD
    await task


@pytest.mark.asyncio
async def test_send_job_result_times_out_when_datachannel_buffer_never_drains(monkeypatch):
    channel = DummyChannel()
    channel.bufferedAmount = MAX_BUFFERED_AMOUNT + 1
    monkeypatch.setattr(channel_module, "BUFFERED_AMOUNT_DRAIN_TIMEOUT_SECONDS", 0.01)

    with pytest.raises(TimeoutError, match="did not drain"):
        await send_job_result(
            channel,
            "job-1",
            DataChannelMessage(
                id="job-1",
                type="file.result",
                attachments=[DataChannelAttachment(id="out", data=b"payload")],
            ),
        )
