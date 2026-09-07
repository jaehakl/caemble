from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.control import launcher_hello_payload
from app.slave_registry import SlaveApp, SlaveAppRegistry, load_manifest
from app.subprocess_manager import WorkerManager


def test_manifest_defaults_to_webrtc_and_hello_advertises_modes(tmp_path) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"id": "ai", "module": "app"}), encoding="utf-8")
    legacy = load_manifest(manifest)
    assert legacy.job_mode == "webrtc"
    legacy.python_executable.parent.mkdir(parents=True)
    legacy.python_executable.touch()
    cae = SlaveApp("cae", "CAE", "app", tmp_path, job_mode="websocket")
    hello = launcher_hello_payload(SimpleNamespace(launcher_name="test"), SlaveAppRegistry([legacy, cae]))
    assert hello["job_modes"] == {"ai": "webrtc", "cae": "websocket"}


@pytest.mark.asyncio
async def test_server_error_does_not_release_slot_before_matching_cleanup(tmp_path) -> None:
    messages = []

    async def send(message):
        messages.append(message)

    manager = WorkerManager(SimpleNamespace(), send, SlaveAppRegistry([]))
    manager.current_job_id = "job"
    manager.current_job_mode = "websocket"
    manager.current_attempt_count = 2
    try:
        await manager.handle_worker_message({"type": "job.error", "job_id": "job", "attempt_count": 2, "detail": "failed"})
        assert manager.current_job_id == "job"
        await manager.handle_worker_message({"type": "job.cleaned", "job_id": "job", "attempt_count": 1})
        assert manager.current_job_id == "job"
        await manager.handle_worker_message({"type": "job.cleaned", "job_id": "job", "attempt_count": 2})
        assert manager.current_job_id is None
        assert [message["type"] for message in messages] == ["job.error", "job.cleaned"]
    finally:
        manager.cancel_cancel_escalation()
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_cleanup_releases_local_slot_before_server_assigns_next_job(tmp_path, monkeypatch) -> None:
    messages = []

    async def send(message):
        messages.append(message)
        if message["type"] == "job.cleaned":
            await manager.start_job(
                job_id="next", handler_type="cae", slave_app_id="cae", job_mode="websocket",
                websocket_url="ws://localhost/next", token="next-token", attempt_count=1,
            )

    app = SlaveApp("cae", "CAE", "app", tmp_path, job_mode="websocket")
    manager = WorkerManager(SimpleNamespace(), send, SlaveAppRegistry([app]))
    manager.worker = SimpleNamespace(process=SimpleNamespace(stdin=SimpleNamespace(write=Mock(), drain=AsyncMock())))
    manager.current_job_id = "previous"
    manager.current_job_mode = "websocket"
    manager.current_attempt_count = 2
    monkeypatch.setattr(manager, "ensure_worker", AsyncMock())

    await manager.handle_worker_message({"type": "job.cleaned", "job_id": "previous", "attempt_count": 2})

    assert messages == [{"type": "job.cleaned", "job_id": "previous", "attempt_count": 2}]
    assert manager.current_job_id == "next"
    assert manager.worker_status == "busy"
    assignment = json.loads(manager.worker.process.stdin.write.call_args.args[0])
    assert assignment["job_id"] == "next"


@pytest.mark.asyncio
async def test_legacy_result_releases_slot_without_cleanup_extension() -> None:
    messages = []

    async def send(message):
        messages.append(message)

    manager = WorkerManager(SimpleNamespace(), send, SlaveAppRegistry([]))
    manager.current_job_id = "legacy"
    await manager.handle_worker_message({"type": "job.result", "job_id": "legacy"})
    assert manager.current_job_id is None
    assert messages == [{"type": "job.result", "job_id": "legacy"}]


@pytest.mark.asyncio
async def test_startup_stdout_exit_is_reported_only_by_start_job() -> None:
    send = AsyncMock()
    manager = WorkerManager(SimpleNamespace(), send, SlaveAppRegistry([]))
    process = SimpleNamespace(stdout=SimpleNamespace(readline=AsyncMock(return_value=b"")))
    manager.worker = SimpleNamespace(process=process, stopping=False, ready=False)
    manager.current_job_id = "starting"
    ready = asyncio.Event()

    await manager.read_worker_stdout(process, ready)

    assert ready.is_set()
    assert manager.current_job_id == "starting"
    send.assert_not_awaited()


@pytest.mark.asyncio
async def test_server_start_failure_confirms_no_worker_owns_assignment(tmp_path, monkeypatch) -> None:
    messages = []

    async def send(message):
        messages.append(message)

    async def fail_start(_):
        raise RuntimeError("environment unavailable")

    app = SlaveApp("cae", "CAE", "app", tmp_path, job_mode="websocket")
    manager = WorkerManager(SimpleNamespace(), send, SlaveAppRegistry([app]))
    monkeypatch.setattr(manager, "ensure_worker", fail_start)
    await manager.start_job(job_id="job", handler_type="cae", slave_app_id="cae", job_mode="websocket", websocket_url="ws://localhost/job", token="scoped", attempt_count=4)
    assert [message["type"] for message in messages] == ["job.error", "job.cleaned"]
    assert messages[-1]["attempt_count"] == 4
    assert manager.current_job_id is None
