from __future__ import annotations

import asyncio
import json
import os
import queue
import subprocess
import sys
import time
from types import SimpleNamespace

import psutil
import pytest
import websockets

from sdk.protocol.packets import receive_packet, send_packet
from sdk.protocol.messages import JobReserve
from sdk.slave.execution import EXECUTION_ENV, ExecutionChannel, configure_torch, cpu_threads, execution_context
from sdk.slave.server import ServerSlaveApp, run_server_job, run_server_worker


@pytest.fixture
def managed(monkeypatch):
    value = {
        "identity": {"launcher_id": "launcher", "boot_id": "boot", "instance_id": "instance",
                     "job_id": "job", "attempt_id": "attempt", "attempt_count": 2, "reservation_id": "reservation"},
        "allocation": {"cpu_ids": psutil.Process().cpu_affinity()[:1], "cpu_cores": 1,
                       "startup_ram_bytes": 1024, "ram_available_bytes": 2048,
                       "gpu_devices": [], "vram_budget_bytes": {}},
    }
    monkeypatch.setenv(EXECUTION_ENV, json.dumps({**value, "execution_protocol": 3}))
    return value


def test_execution_fences_every_identity_field(managed):
    context = execution_context()
    context.require_identity(context.envelope({"type": "job.complete"}))
    for field in managed["identity"]:
        stale = {**managed["identity"], field: "stale"}
        with pytest.raises(ValueError, match="execution attempt"):
            context.require_identity(stale)


def test_resolved_resources_flag_is_optional_and_survives_control_validation(managed):
    request = {"type": "job.reserve", **managed["identity"], "handler_type": "prediction.train",
               "slave_app_id": "predictor-training", "job_mode": "websocket"}
    assert JobReserve.model_validate(request).resources_resolved is False
    assert JobReserve.model_validate({**request, "resources_resolved": True}).model_dump()["resources_resolved"] is True
    with pytest.raises(ValueError):
        JobReserve.model_validate({**request, "resources_resolved": "true"})


@pytest.mark.parametrize("version", [None, 2])
def test_worker_requires_budget_enforcement_protocol(managed, monkeypatch, version):
    monkeypatch.setenv(EXECUTION_ENV, json.dumps({**managed, "execution_protocol": version}))
    with pytest.raises(ValueError, match="protocol 3 required"):
        execution_context()


def test_allocated_native_threads_override_auto_and_cap_explicit_values(managed):
    assert cpu_threads(None) == cpu_threads(0) == cpu_threads(99) == 1
    calls = []
    torch = SimpleNamespace(set_num_threads=lambda value: calls.append(("intra", value)),
                            set_num_interop_threads=lambda value: calls.append(("inter", value)))
    configure_torch(torch)
    configure_torch(torch)
    assert calls == [("inter", 1), ("intra", 1)]


def test_control_frames_preserve_payload_and_binary_data(managed):
    sent = []
    channel = ExecutionChannel(SimpleNamespace(send=sent.append), execution_context())
    channel.send(json.dumps({"kind": "job.event", "id": "call-2", "payload": {"unchanged": True}}))
    channel.send(b"attachment")
    assert json.loads(sent[0]) == {"kind": "job.event", "id": "call-2", "payload": {"unchanged": True}, **managed["identity"]}
    assert sent[1] == b"attachment"


def test_bootstrap_waits_for_containment_before_importing_app(tmp_path, managed):
    marker = tmp_path / "imported"
    module = tmp_path / "fake_worker.py"
    module.write_text(
        "import json, os, pathlib, psutil\n"
        "pathlib.Path('imported').touch()\n"
        "print(json.dumps({'affinity': psutil.Process().cpu_affinity(), 'cpu': os.environ['OMP_NUM_THREADS'], 'gpu': os.environ['CUDA_VISIBLE_DEVICES']}), flush=True)\n",
        encoding="utf-8",
    )
    process = subprocess.Popen([sys.executable, "-m", "sdk.slave.bootstrap", "--module", "fake_worker", "--worker"],
                               cwd=tmp_path, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding="utf-8", env={**os.environ, "PYTHONPATH": str(tmp_path)})
    try:
        time.sleep(.1)
        assert process.poll() is None and not marker.exists()
        output, errors = process.communicate(json.dumps({"type": "bootstrap.start"}) + "\n", timeout=10)
        assert process.returncode == 0, errors
        assert json.loads(output) == {"affinity": managed["allocation"]["cpu_ids"], "cpu": "1", "gpu": ""}
        assert marker.exists()
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)


@pytest.mark.asyncio
async def test_managed_server_packets_and_cleanup_carry_identity(managed, monkeypatch):
    lifecycle = []
    monkeypatch.setattr("sdk.slave.server.emit", lambda value: lifecycle.append(value))
    identity = managed["identity"]
    cleaned = False

    async def handler(payload, _, context):
        nonlocal cleaned
        assert payload["value"] == "unaltered"
        assert context.execution.identity.attempt_id == identity["attempt_id"]
        cleaned = True
        return {"recordSequences": []}

    async def server(websocket):
        ready, _ = await receive_packet(websocket.recv)
        assert all(ready[key] == value for key, value in identity.items())
        await send_packet(websocket.send, websocket.send, {"type": "job.input", "value": "unaltered", **identity})
        complete, _ = await receive_packet(websocket.recv)
        assert cleaned and complete == {"type": "job.complete", "recordSequences": [], **identity}
        await send_packet(websocket.send, websocket.send, {"type": "job.cancel", **identity, "attempt_id": "previous"})
        await send_packet(websocket.send, websocket.send, {"type": "job.complete.ack", **identity})

    async with websockets.serve(server, "127.0.0.1", 0) as listener:
        port = listener.sockets[0].getsockname()[1]
        await asyncio.wait_for(run_server_job(ServerSlaveApp(handler), {
            **identity, "token": "scoped", "websocket_url": f"ws://127.0.0.1:{port}",
        }), timeout=5)
    assert lifecycle[-1]["type"] == "job.cleaned"
    assert lifecycle[0] == {"type": "job.running", "job_id": identity["job_id"], "attempt_count": identity["attempt_count"]}
    assert not any(item["type"] == "job.error" for item in lifecycle)


@pytest.mark.asyncio
async def test_worker_ignores_duplicate_assignment_and_stale_cancel(managed, monkeypatch):
    lines = queue.Queue()
    calls = []
    started = asyncio.Event()
    cancelled = asyncio.Event()
    identity = managed["identity"]
    monkeypatch.setattr("sdk.slave.server.read_stdin_line", lines.get)
    monkeypatch.setattr("sdk.slave.server.emit", lambda _: None)

    async def execute(_, message):
        calls.append(message)
        started.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            cancelled.set()

    monkeypatch.setattr("sdk.slave.server.run_server_job", execute)
    assignment = {"type": "job.start", "job_mode": "websocket", **identity}
    lines.put(json.dumps(assignment))
    worker = asyncio.create_task(run_server_worker(ServerSlaveApp(lambda *_: None)))
    try:
        await asyncio.wait_for(started.wait(), 2)
        lines.put(json.dumps(assignment))
        lines.put(json.dumps({"type": "job.cancel", **identity, "attempt_id": "old"}))
        await asyncio.sleep(.03)
        assert len(calls) == 1 and not cancelled.is_set()
        lines.put(json.dumps({"type": "job.cancel", **identity}))
        await asyncio.wait_for(worker, 2)
        assert cancelled.is_set()
    finally:
        lines.put("")
        if not worker.done():
            worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)
