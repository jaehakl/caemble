from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.control import ControlConnection, expire_control_grace, launcher_hello_payload
from app.journal import LauncherJournal
from app.resources import GIB, ResourceLedger, ResourcePolicy
from app.slave_registry import SlaveApp, SlaveAppRegistry
from app.subprocess_manager import WorkerManager


def make_manager(tmp_path, *, cores=12, ram=16 * GIB, journal=None):
    policy = ResourcePolicy(cpu_cores=cores, ram_budget_bytes=ram, ram_growth_headroom_bytes=GIB,
                            system_ram_headroom_bytes=GIB)
    ledger = ResourceLedger(policy, cpu_ids=list(range(cores)), total_ram=64 * GIB)
    ledger.sample({}, launcher_rss=100, available_ram=32 * GIB, gpus=[])
    registry = SlaveAppRegistry([SlaveApp("cae", "CAE", "app", tmp_path, job_mode="websocket"),
                                 SlaveApp("ai", "AI", "app", tmp_path)])
    settings = SimpleNamespace(launcher_name="test", worker_ready_timeout_seconds=1)
    manager = WorkerManager(settings, AsyncMock(), registry, ledger=ledger, journal=journal)
    manager.launcher_id = "launcher"
    return manager


def offer(manager, index, app="cae"):
    return {"type": "job.reserve", "launcher_id": manager.launcher_id, "boot_id": manager.boot_id,
            "instance_id": f"instance-{index}", "job_id": f"job-{index}", "attempt_id": f"attempt-{index}",
            "attempt_count": 1, "reservation_id": f"reservation-{index}", "handler_type": app,
            "slave_app_id": app, "job_mode": "websocket" if app == "cae" else "webrtc", "resources": {"cpu_cores": 4}}


@pytest.mark.asyncio
async def test_atomic_parallel_reservations_and_cleanup_admit_next(tmp_path):
    manager = make_manager(tmp_path)
    offers = [offer(manager, i) for i in range(4)]
    await asyncio.gather(*(manager.reserve_job(value) for value in offers))
    assert len(manager.instances) == 3
    assert manager.send_control.call_args_list[-1].args[0]["reason"] == "cpu_unavailable"
    allocations = [worker.allocation["cpu_ids"] for worker in manager.instances.values()]
    assert len({cpu for ids in allocations for cpu in ids}) == 12
    await manager.reserve_job(offers[0])
    assert len(manager.instances) == 3
    worker = manager.instances["instance-0"]
    await manager.cancel_job(offers[0])
    await worker.cleanup_task
    await manager.reserve_job(offers[3])
    assert "instance-3" in manager.instances
    assert "instance-1" in manager.instances
    await manager.stop_all("test done")


@pytest.mark.asyncio
async def test_no_start_without_matching_reservation_and_duplicate_start(tmp_path, monkeypatch):
    manager = make_manager(tmp_path)
    value = offer(manager, 1)
    start = {**value, "type": "job.start", "allocation": {}}
    await manager.start_job(start)
    assert not manager.instances
    await manager.reserve_job(value)
    worker = manager.instances[value["instance_id"]]
    launch = AsyncMock()
    monkeypatch.setattr(manager, "launch_worker", launch)
    start["allocation"] = worker.allocation
    await asyncio.gather(manager.start_job(start), manager.start_job(start))
    await worker.start_task
    launch.assert_awaited_once()
    await manager.cancel_job({**value, "attempt_id": "stale"})
    assert worker.cleanup_task is None
    await manager.stop_all("test done")


@pytest.mark.asyncio
async def test_terminal_holds_resources_until_container_empty_and_isolates_other_job(tmp_path):
    manager = make_manager(tmp_path)
    for index, app in ((1, "cae"), (2, "ai")):
        await manager.reserve_job(offer(manager, index, app))
    worker = manager.instances["instance-1"]
    cleaned = asyncio.Event()
    async def finish(_):
        await cleaned.wait()
    worker.container = SimpleNamespace(stop=AsyncMock(side_effect=finish))
    await manager.handle_worker_message(worker, {"type": "job.error", **worker.identity, "detail": "failed"})
    await asyncio.sleep(0)
    assert len(manager.ledger.reservations) == 2
    await manager.handle_worker_message(worker, {"type": "job.cleaned", **worker.identity, "attempt_count": 0})
    assert "instance-1" in manager.instances
    cleaned.set()
    await worker.cleanup_task
    assert "instance-1" not in manager.instances and "instance-2" in manager.instances
    assert manager.receipts["instance-1"]["terminal"]["type"] == "job.error"
    await manager.stop_all("test done")


@pytest.mark.asyncio
async def test_failed_cleanup_quarantines_reservation(tmp_path):
    manager = make_manager(tmp_path)
    value = offer(manager, 1)
    await manager.reserve_job(value)
    worker = manager.instances[value["instance_id"]]
    worker.container = SimpleNamespace(stop=AsyncMock(side_effect=RuntimeError("still alive")))
    await manager.cancel_job(value)
    await worker.cleanup_task
    assert worker.status == "cleanup_failed"
    assert value["instance_id"] in manager.ledger.reservations
    assert not manager.receipts


@pytest.mark.asyncio
async def test_repeated_cancel_retries_failed_cleanup_without_releasing_early(tmp_path):
    manager = make_manager(tmp_path)
    value = offer(manager, 1)
    await manager.reserve_job(value)
    worker = manager.instances[value["instance_id"]]
    worker.container = SimpleNamespace(stop=AsyncMock(side_effect=[RuntimeError("temporary process query failure"), None]))
    await manager.cancel_job(value)
    await worker.cleanup_task
    previous_cleanup = worker.cleanup_task
    assert worker.status == "cleanup_failed"
    assert value["instance_id"] in manager.ledger.reservations

    await manager.cancel_job(value)
    await worker.cleanup_task
    assert worker.cleanup_task is not previous_cleanup
    assert worker.container.stop.await_count == 2
    assert not manager.instances and not manager.ledger.reservations
    assert manager.receipts[value["instance_id"]]["terminal"]["type"] == "job.cancelled"


@pytest.mark.asyncio
async def test_cancel_during_readiness_does_not_start_a_worker(tmp_path, monkeypatch):
    import threading

    manager = make_manager(tmp_path)
    checking, proceed = threading.Event(), threading.Event()

    def check_ready(_):
        checking.set()
        assert proceed.wait(5)

    monkeypatch.setattr(SlaveApp, "check_ready", check_ready)
    manager.container_factory = Mock()
    value = offer(manager, 1)
    await manager.reserve_job(value)
    worker = manager.instances[value["instance_id"]]
    try:
        await manager.start_job({**value, "type": "job.start", "allocation": worker.allocation})
        assert await asyncio.to_thread(checking.wait, 2)
        await manager.cancel_job(value)
    finally:
        proceed.set()
        await manager.close()
    manager.container_factory.assert_not_called()
    assert not manager.instances and not manager.ledger.reservations
    assert manager.receipts[value["instance_id"]]["terminal"]["type"] == "job.cancelled"


@pytest.mark.asyncio
async def test_journal_receipts_survive_reconnect_and_only_matching_ack_removes(tmp_path):
    journal = LauncherJournal(tmp_path / "state")
    manager = make_manager(tmp_path, journal=journal)
    value = offer(manager, 1)
    await manager.reserve_job(value)
    worker = manager.instances[value["instance_id"]]
    await manager.cancel_job(value)
    await worker.cleanup_task
    await manager.acknowledge_cleanup({**value, "attempt_id": "old"})
    assert manager.receipts
    installation = journal.data["installation_id"]
    journal.close()
    journal = LauncherJournal(tmp_path / "state")
    other = make_manager(tmp_path, journal=journal)
    assert other.installation_id == installation and other.boot_id != manager.boot_id
    assert other.receipts
    await other.acknowledge_cleanup(value)
    assert not journal.data["cleanup_receipts"]
    # A delayed duplicate in the same connection cannot resurrect a cleaned attempt.
    other.boot_id = value["boot_id"]
    await other.reserve_job(value)
    assert not other.instances
    journal.close()


@pytest.mark.asyncio
async def test_real_bootstrapped_instances_overlap_and_keep_attempt_results(tmp_path, monkeypatch):
    import sys
    import time
    import psutil
    from app.settings import LauncherSettings

    available = psutil.Process().cpu_affinity()
    if len(available) < 2:
        pytest.skip("parallel CPU allocation requires two available logical CPUs")
    module = tmp_path / "fixture_worker.py"
    module.write_text(
        "import json,os,sys,time\nfrom pathlib import Path\n"
        "identity=json.loads(os.environ['CAEMBLE_EXECUTION_JSON'])['identity']\n"
        "print(json.dumps({'type':'worker.ready',**identity}),flush=True)\n"
        "for line in sys.stdin:\n"
        " message=json.loads(line)\n"
        " if message['type']=='job.start':\n"
        "  print(json.dumps({'type':'job.running',**identity}),flush=True)\n"
        "  while not Path('release').exists(): time.sleep(.01)\n"
        "  print(json.dumps({'type':'job.result',**identity}),flush=True)\n"
        "  print(json.dumps({'type':'job.cleaned',**identity}),flush=True)\n"
        "  break\n", encoding="utf-8")
    from pathlib import Path
    monkeypatch.setattr(SlaveApp, "python_executable", property(lambda _: Path(sys.executable)))
    app = SlaveApp("cae", "Fixture", "fixture_worker", tmp_path, job_mode="websocket")
    policy = ResourcePolicy(cpu_cores=2, ram_budget_bytes=8 * GIB, ram_growth_headroom_bytes=GIB,
                            system_ram_headroom_bytes=GIB)
    ledger = ResourceLedger(policy, cpu_ids=available[:2], total_ram=16 * GIB)
    ledger.sample({}, launcher_rss=0, available_ram=16 * GIB, gpus=[])
    events = []
    async def send(message):
        events.append((time.monotonic(), message))
        if sum(event["type"] == "job.running" for _, event in events) == 2:
            (tmp_path / "release").touch()
    manager = WorkerManager(LauncherSettings(_env_file=None, api_url="http://localhost", access_token="fixture"),
                            send, SlaveAppRegistry([app]), ledger=ledger)
    manager.launcher_id = "launcher"
    try:
        for index in (1, 2):
            reservation = offer(manager, index)
            reservation["resources"] = {"cpu_cores": 1}
            await manager.reserve_job(reservation)
            worker = manager.instances[reservation["instance_id"]]
            await manager.start_job({**reservation, "type": "job.start", "allocation": worker.allocation,
                                     "websocket_url": "ws://localhost/fixture", "token": "fixture"})
        deadline = time.monotonic() + 10
        while manager.instances:
            assert time.monotonic() < deadline
            await asyncio.sleep(.01)
        starts = [stamp for stamp, message in events if message["type"] == "job.running"]
        results = [(stamp, message) for stamp, message in events if message["type"] == "job.result"]
        assert len(starts) == len(results) == 2, events
        assert max(index for index, (_, message) in enumerate(events) if message["type"] == "job.running") < min(
            index for index, (_, message) in enumerate(events) if message["type"] == "job.result")
        assert {message["attempt_id"] for _, message in results} == {"attempt-1", "attempt-2"}
        assert not ledger.reservations
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_control_reconnect_keeps_jobs_and_relabels_queued_events(tmp_path):
    manager = make_manager(tmp_path)
    await manager.reserve_job(offer(manager, 1))
    connection = ControlConnection()
    await connection.send({"type": "job.progress", "instance_id": "instance-1", "progress": 1})
    grace = asyncio.create_task(expire_control_grace(manager, 30))
    grace.cancel()
    await asyncio.gather(grace, return_exceptions=True)
    assert len(manager.instances) == 1
    connection.websocket = SimpleNamespace(send=AsyncMock())
    connection.session_id = "new-session"
    await connection.flush()
    assert '"session_id": "new-session"' in connection.websocket.send.call_args.args[0]
    await expire_control_grace(manager, 0.001)
    assert not manager.instances


@pytest.mark.asyncio
async def test_lost_reservation_ack_replays_without_reserving_twice(tmp_path, monkeypatch):
    connection = ControlConnection()
    manager = make_manager(tmp_path)
    manager.send_control = connection.send
    reservation = offer(manager, 1)
    await manager.reserve_job(reservation)
    assert manager.inventory()[0]["status"] == "reserved"
    assert len(connection.pending) == 1
    connection.websocket = SimpleNamespace(send=AsyncMock())
    connection.session_id = "reconnected"
    await connection.flush()
    await manager.reserve_job(reservation)
    assert len(manager.ledger.reservations) == 1
    assert manager.resource_report()["cpu_reserved"] == 4
    worker = manager.instances[reservation["instance_id"]]
    launch = AsyncMock()
    monkeypatch.setattr(manager, "launch_worker", launch)
    start = {**reservation, "type": "job.start", "allocation": worker.allocation}
    await manager.start_job(start)
    await worker.start_task
    # Lost running/start acknowledgement is reconciled from the same instance.
    await manager.start_job(start)
    launch.assert_awaited_once()
    await manager.close()


@pytest.mark.asyncio
async def test_new_boot_waits_for_recovery_before_persisting_cleanup_proof(tmp_path, monkeypatch):
    journal = LauncherJournal(tmp_path / "state")
    previous = make_manager(tmp_path, journal=journal)
    reservation = offer(previous, 1)
    await previous.reserve_job(reservation)
    entry = journal.data["instances"][reservation["instance_id"]]
    entry["container"] = {"pid": 123, "created_at": 456}
    journal.save()
    journal.close()
    journal = LauncherJournal(tmp_path / "state")
    current = make_manager(tmp_path, journal=journal)
    recovered = asyncio.Event()
    async def recover(state):
        assert state == {"pid": 123, "created_at": 456}
        await recovered.wait()
    monkeypatch.setattr("app.subprocess_manager.recover_container", recover)
    monkeypatch.setattr(current, "sample_resources", AsyncMock())
    initialization = asyncio.create_task(current.initialize())
    await asyncio.sleep(0)
    assert not current.receipts
    assert journal.data["instances"]
    recovered.set()
    await initialization
    assert current.receipts[reservation["instance_id"]]["boot_id"] == previous.boot_id
    assert current.boot_id != previous.boot_id
    assert not journal.data["instances"]
    await current.close()


def test_hello_inventory_is_protocol_two(tmp_path):
    manager = make_manager(tmp_path)
    hello = launcher_hello_payload(manager.settings, manager.registry, manager, "session")
    assert hello["execution_protocol"] == 2
    assert hello["boot_id"] == manager.boot_id
    assert "current_job_id" not in hello


def test_application_readiness_controls_advertisement(tmp_path, monkeypatch):
    from pathlib import Path
    import sys
    monkeypatch.setattr(SlaveApp, "python_executable", property(lambda _: Path(sys.executable)))
    passing = SlaveApp("evaluation", "Evaluation", "app", tmp_path, job_mode="websocket",
                      readiness_args=("-c", "raise SystemExit(0)"))
    failing = SlaveApp("evaluation", "Evaluation", "app", tmp_path, job_mode="websocket",
                      readiness_args=("-c", "raise SystemExit(1)"))
    assert passing.executable_ready
    assert not failing.executable_ready
    manager = make_manager(tmp_path)
    manager.registry = SlaveAppRegistry([failing])
    assert launcher_hello_payload(manager.settings, manager.registry, manager, "session")["slave_app_ids"] == []
