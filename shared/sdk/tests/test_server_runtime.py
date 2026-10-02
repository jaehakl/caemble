from __future__ import annotations

import asyncio
import json
import subprocess
import sys

import pytest
import websockets

from sdk.protocol.packets import Attachment, receive_packet, send_packet
from sdk.slave.server import ServerSlaveApp, run_server_job


def test_server_runtime_does_not_import_webrtc_runtime() -> None:
    result = subprocess.run(
        [sys.executable, "-c", "import json,sys; import sdk.slave.server; print(json.dumps([name for name in sys.modules if name in ('aiortc', 'sdk.slave.worker', 'sdk.slave.rtc')]))"],
        check=True, capture_output=True, text=True,
    )
    assert json.loads(result.stdout) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("stalled", [False, True])
async def test_initial_input_uses_idle_timeout_between_frames(monkeypatch, stalled) -> None:
    lifecycle = []
    executed = False
    monkeypatch.setattr("sdk.slave.server.emit", lifecycle.append)
    monkeypatch.setattr("sdk.slave.server.INPUT_IDLE_TIMEOUT_SECONDS", 0.1)

    async def handler(message, *_):
        nonlocal executed
        assert message["measurement"] == {"source": "input" * 30}
        executed = True
        return {"recordSequences": []}

    async def server(websocket):
        await receive_packet(websocket.recv)
        if stalled:
            await websocket.wait_closed()
            return

        async def send_bytes(data):
            for offset in range(0, len(data), 16):
                await asyncio.sleep(0.03)
                await websocket.send(data[offset:offset + 16])

        started = asyncio.get_running_loop().time()
        await send_packet(websocket.send, send_bytes, {"type": "job.input", "measurement": {"source": "input" * 30}})
        assert asyncio.get_running_loop().time() - started > 0.2
        complete, _ = await receive_packet(websocket.recv)
        assert complete["type"] == "job.complete"
        await send_packet(websocket.send, websocket.send, {"type": "job.complete.ack"})

    async with websockets.serve(server, "127.0.0.1", 0) as listener:
        port = listener.sockets[0].getsockname()[1]
        await asyncio.wait_for(run_server_job(ServerSlaveApp(handler), {
            "job_id": "input", "attempt_count": 1, "token": "scoped",
            "websocket_url": f"ws://127.0.0.1:{port}",
        }), timeout=3)
    assert executed is not stalled
    assert [item["type"] for item in lifecycle] == (["job.error", "job.cleaned"] if stalled else ["job.cleaned"])


@pytest.mark.asyncio
async def test_server_job_acknowledges_record_before_completion_and_cleanup(monkeypatch) -> None:
    lifecycle = []
    closed = asyncio.Event()
    monkeypatch.setattr("sdk.slave.server.emit", lifecycle.append)

    async def handler(message, attachments, context):
        assert message["measurement"] == {"test": True}
        assert attachments == []
        try:
            await context.send({"type": "job.record", "sequence": 1, "name": "field", "value": {}}, [Attachment(id="field", data=b"data")])
            ack, _ = await context.receive()
            assert ack == {"type": "job.record.ack", "sequence": 1}
            return {"recordSequences": [1]}
        finally:
            await asyncio.sleep(0.01)
            closed.set()

    async def server(websocket):
        ready, _ = await receive_packet(websocket.recv)
        assert ready == {"type": "job.ready", "job_id": "job", "attempt_count": 2}
        await send_packet(websocket.send, websocket.send, {"type": "job.input", "measurement": {"test": True}})
        record, attachments = await receive_packet(websocket.recv)
        assert record["sequence"] == 1
        assert attachments[0].data == b"data"
        assert not closed.is_set()
        await send_packet(websocket.send, websocket.send, {"type": "job.record.ack", "sequence": 1})
        complete, _ = await receive_packet(websocket.recv)
        assert closed.is_set()
        assert complete == {"type": "job.complete", "recordSequences": [1]}
        await send_packet(websocket.send, websocket.send, {"type": "job.complete.ack"})

    async with websockets.serve(server, "127.0.0.1", 0, max_size=None) as listener:
        port = listener.sockets[0].getsockname()[1]
        await run_server_job(ServerSlaveApp(handler), {"job_id": "job", "attempt_count": 2, "token": "scoped", "websocket_url": f"ws://127.0.0.1:{port}"})
    assert lifecycle == [{"type": "job.cleaned", "job_id": "job", "attempt_count": 2}]


@pytest.mark.asyncio
async def test_server_disconnect_waits_for_handler_cleanup_before_cleaned(monkeypatch) -> None:
    lifecycle = []
    running = asyncio.Event()
    cleaned = asyncio.Event()

    def emit(message):
        if message["type"] == "job.cleaned":
            assert cleaned.is_set()
        lifecycle.append(message)

    monkeypatch.setattr("sdk.slave.server.emit", emit)

    async def handler(*_):
        running.set()
        try:
            await asyncio.Future()
        finally:
            await asyncio.sleep(0.02)
            cleaned.set()

    async def server(websocket):
        await receive_packet(websocket.recv)
        await send_packet(websocket.send, websocket.send, {"type": "job.input"})
        await running.wait()
        await websocket.close()

    async with websockets.serve(server, "127.0.0.1", 0) as listener:
        port = listener.sockets[0].getsockname()[1]
        await run_server_job(ServerSlaveApp(handler), {"job_id": "job", "attempt_count": 3, "token": "scoped", "websocket_url": f"ws://127.0.0.1:{port}"})
    assert [item["type"] for item in lifecycle] == ["job.error", "job.cleaned"]


@pytest.mark.asyncio
async def test_cancellation_is_acknowledged_after_cleanup(monkeypatch) -> None:
    lifecycle = []
    running = asyncio.Event()
    cleaned = asyncio.Event()
    monkeypatch.setattr("sdk.slave.server.emit", lifecycle.append)

    async def handler(*_):
        running.set()
        try:
            await asyncio.Future()
        finally:
            await asyncio.sleep(0.02)
            cleaned.set()

    async def server(websocket):
        await receive_packet(websocket.recv)
        await send_packet(websocket.send, websocket.send, {"type": "job.input"})
        cancelled, _ = await receive_packet(websocket.recv)
        assert cancelled["type"] == "job.cancelled"
        assert cleaned.is_set()
        await send_packet(websocket.send, websocket.send, {"type": "job.complete.ack"})

    async with websockets.serve(server, "127.0.0.1", 0) as listener:
        port = listener.sockets[0].getsockname()[1]
        job = asyncio.create_task(run_server_job(ServerSlaveApp(handler), {"job_id": "job", "attempt_count": 4, "token": "scoped", "websocket_url": f"ws://127.0.0.1:{port}"}))
        await running.wait()
        job.cancel()
        await asyncio.sleep(0.005)
        job.cancel()
        await job
    assert cleaned.is_set()
    assert lifecycle == [{"type": "job.cleaned", "job_id": "job", "attempt_count": 4}]


@pytest.mark.asyncio
async def test_direct_server_cancel_stops_silent_compute_without_launcher(monkeypatch) -> None:
    running = asyncio.Event()
    cleaned = asyncio.Event()
    lifecycle = []
    monkeypatch.setattr("sdk.slave.server.emit", lifecycle.append)

    async def handler(*_):
        running.set()
        try:
            await asyncio.Future()
        finally:
            await asyncio.sleep(0.01)
            cleaned.set()

    async def server(websocket):
        await receive_packet(websocket.recv)
        await send_packet(websocket.send, websocket.send, {"type": "job.input"})
        await running.wait()
        await send_packet(websocket.send, websocket.send, {"type": "job.cancel", "reason": "stopped"})
        cancelled, _ = await receive_packet(websocket.recv)
        assert cancelled["type"] == "job.cancelled"
        assert cleaned.is_set()

    async with websockets.serve(server, "127.0.0.1", 0) as listener:
        port = listener.sockets[0].getsockname()[1]
        await asyncio.wait_for(run_server_job(ServerSlaveApp(handler), {"job_id": "job", "attempt_count": 5, "token": "scoped", "websocket_url": f"ws://127.0.0.1:{port}"}), timeout=3)
    assert cleaned.is_set()
    assert lifecycle == [{"type": "job.cleaned", "job_id": "job", "attempt_count": 5}]
