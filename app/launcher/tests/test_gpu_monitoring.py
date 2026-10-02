import asyncio
import os
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app import subprocess_manager as supervisor
from app.resources import GIB
from test_worker_modes import make_manager, offer


@pytest.fixture
def monitored_manager(tmp_path, monkeypatch):
    manager = make_manager(tmp_path)
    manager.ledger.policy.gpu_count = 1
    manager.ledger.policy.defaults = {"cae": {"vram_budget_gb": 6}}
    gpus = [{"uuid": "GPU-a", "total_bytes": 24*GIB, "free_bytes": 20*GIB}]
    monkeypatch.setattr(supervisor, "discover_gpus", lambda: gpus)
    manager.gpu_monitor = SimpleNamespace(sample=Mock(return_value={"GPU-a": {os.getpid(): GIB}}), close=Mock())
    return manager, gpus


@pytest.mark.asyncio
async def test_process_monitor_only_queries_visible_devices(monitored_manager, monkeypatch):
    manager, gpus = monitored_manager
    gpus.append({"uuid": "GPU-hidden", "total_bytes": 24*GIB, "free_bytes": 20*GIB})
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "0")
    await manager.sample_resources()
    manager.gpu_monitor.sample.assert_called_once_with(["GPU-a"])
    assert [gpu["uuid"] for gpu in manager.ledger.gpu_report()] == ["GPU-a"]
    await manager.close()


@pytest.mark.asyncio
async def test_reaching_budget_stops_only_offender_even_during_start(monitored_manager):
    manager, gpus = monitored_manager
    await manager.sample_resources()
    value = offer(manager, 1)
    await manager.reserve_job(value)
    first = manager.instances[value["instance_id"]]
    first.container = SimpleNamespace(pids=lambda: [os.getpid()], rss=lambda: 0, stop=AsyncMock())
    manager.ledger.mark_running(value["instance_id"])
    for index in range(3):
        manager.ledger.sample({}, launcher_rss=0, available_ram=32*GIB, gpus=gpus,
            now=time.monotonic()+index+1, gpu_process_metrics_complete=True)
    other = offer(manager, 2)
    await manager.reserve_job(other)
    assert len(manager.instances) == 2
    first.start_task = asyncio.create_task(asyncio.sleep(120))
    manager.gpu_monitor.sample.return_value = {"GPU-a": {os.getpid(): 6*GIB}}
    await manager.sample_resources()
    await first.cleanup_task
    assert first.start_task.cancelled()
    first.container.stop.assert_awaited_once_with(0)
    assert first.terminal["code"] == "gpu_memory_budget_exceeded"
    assert other["instance_id"] in manager.instances
    assert value["instance_id"] not in manager.ledger.reservations
    await manager.close()


@pytest.mark.asyncio
async def test_slow_query_is_stale_and_cannot_kill_a_job(monitored_manager, monkeypatch):
    manager, _ = monitored_manager
    await manager.sample_resources()
    value = offer(manager, 1)
    await manager.reserve_job(value)
    worker = manager.instances[value["instance_id"]]
    worker.container = SimpleNamespace(pids=lambda: [os.getpid()], rss=lambda: 0, stop=AsyncMock())
    clock = SimpleNamespace(now=time.monotonic())
    monkeypatch.setattr(supervisor, "time", SimpleNamespace(monotonic=lambda: clock.now))
    def slow_query(devices):
        clock.now += 4
        return {"GPU-a": {os.getpid(): 7*GIB}}
    manager.gpu_monitor.sample.side_effect = slow_query
    await manager.sample_resources()
    assert worker.terminal is None and worker.vram_used_bytes is None
    assert worker.vram_monitoring_warning
    assert not manager.ledger.gpu_process_metrics_complete
    await manager.close()


@pytest.mark.asyncio
async def test_monitor_loss_warns_once_keeps_job_and_recovery_checks_budget(monitored_manager, capsys):
    manager, _ = monitored_manager
    await manager.sample_resources()
    value = offer(manager, 1)
    await manager.reserve_job(value)
    worker = manager.instances[value["instance_id"]]
    worker.container = SimpleNamespace(pids=lambda: [os.getpid()], rss=lambda: 0, stop=AsyncMock())
    await manager.sample_resources()
    worker.vram_valid_at = manager.gpu_valid_at = time.monotonic()-4
    manager.gpu_monitor.sample.side_effect = RuntimeError("lost counters")
    await manager.sample_resources()
    assert worker.terminal is None and worker.vram_used_bytes is None
    assert worker.vram_monitoring_warning and manager.resource_report()["vram_monitoring_warning"]
    assert not manager.ledger.gpu_report()[0]["admission_open"]
    assert "감시 불가" in capsys.readouterr().out
    await manager.sample_resources()
    assert capsys.readouterr().out == ""
    manager.gpu_monitor.sample.side_effect = None
    manager.gpu_monitor.sample.return_value = {"GPU-a": {os.getpid(): 7*GIB}}
    await manager.sample_resources()
    await worker.cleanup_task
    assert worker.vram_monitoring_warning is None
    assert worker.terminal["code"] == "gpu_memory_budget_exceeded"
    assert "감시 복구" in capsys.readouterr().out
    await manager.close()


@pytest.mark.asyncio
async def test_pid_reuse_during_query_is_unknown_not_zero_or_an_overrun(monitored_manager, monkeypatch):
    manager, _ = monitored_manager
    await manager.sample_resources()
    value = offer(manager, 1)
    await manager.reserve_job(value)
    worker = manager.instances[value["instance_id"]]
    worker.container = SimpleNamespace(pids=lambda: [123], rss=lambda: 0, stop=AsyncMock())
    identities = iter([{123: 1.0}, {123: 2.0}])
    monkeypatch.setattr(supervisor, "process_identities", lambda _: next(identities))
    manager.gpu_monitor.sample.return_value = {"GPU-a": {123: 8*GIB}}
    await manager.sample_resources()
    assert worker.vram_used_bytes is None and worker.terminal is None
    assert not manager.ledger.gpu_process_metrics_complete
    await manager.close()
