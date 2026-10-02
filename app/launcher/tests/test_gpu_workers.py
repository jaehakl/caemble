"""GPU slot lifecycle through WorkerManager and optional real CUDA processes."""
import asyncio
import os
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import psutil
import pytest

from app import resources
from app.resources import GIB, ResourceLedger, ResourcePolicy, discover_gpus
from app.settings import LauncherSettings
from app.slave_registry import SlaveApp, SlaveAppRegistry
from app.subprocess_manager import WorkerManager
from test_worker_modes import make_manager, offer


@pytest.mark.asyncio
async def test_gpu_concurrent_reservations_cleanup_failure_and_stale_messages(tmp_path, monkeypatch):
    clock = SimpleNamespace(now=100.0)
    monkeypatch.setattr(resources, "time", SimpleNamespace(monotonic=lambda: clock.now))
    manager = make_manager(tmp_path)
    manager.ledger.policy.gpu_count = 1
    manager.ledger.policy.defaults = {"cae": {"vram_budget_gb": 8}}

    def sample():
        clock.now += 1
        manager.ledger.sample({}, launcher_rss=0, available_ram=32 * GIB,
            gpus=[{"uuid": "GPU-a", "total_bytes": 16 * GIB, "free_bytes": 14 * GIB}], gpu_process_metrics_complete=True)

    sample()
    offers = [offer(manager, index) for index in range(3)]
    for value in offers:
        value["resources"]["cpu_cores"] = 1
    await asyncio.gather(*(manager.reserve_job(value) for value in offers))
    assert len(manager.instances) == 1
    first = manager.instances["instance-0"]
    await manager.handle_worker_message(first, {"type": "job.running", **first.identity})
    for _ in range(3):
        sample()
    await asyncio.gather(*(manager.reserve_job(value) for value in offers))
    assert len(manager.instances) == 2
    second = manager.instances["instance-1"]
    await manager.handle_worker_message(second, {"type": "job.running", **second.identity})
    for _ in range(3):
        sample()
    await manager.reserve_job(offers[2])
    assert len(manager.instances) == 2
    await manager.cancel_job({**offers[0], "attempt_id": "old"})
    assert first.cleanup_task is None
    first.container = SimpleNamespace(stop=AsyncMock(side_effect=RuntimeError("tree still alive")))
    await manager.cancel_job(offers[0])
    await first.cleanup_task
    assert first.status == "cleanup_failed"
    assert manager.ledger.gpu_report()[0]["job_count"] == 2
    await manager.reserve_job(offers[2])
    assert len(manager.instances) == 2
    first.container.stop = AsyncMock()
    await manager.cancel_job(offers[0])
    await first.cleanup_task
    await manager.reserve_job(offers[2])
    assert len(manager.instances) == 1  # No post-cleanup telemetry yet.
    for _ in range(3):
        sample()
    await manager.reserve_job(offers[2])
    assert len(manager.instances) == 2 and manager.instances["instance-1"] is second
    await manager.stop_all("test finished")
    assert not manager.ledger.reservations


@pytest.mark.asyncio
async def test_running_message_waiting_for_ledger_cannot_resurrect_cleaned_worker(tmp_path):
    manager = make_manager(tmp_path)
    value = offer(manager, 1)
    await manager.reserve_job(value)
    worker = manager.instances[value["instance_id"]]
    await manager.ledger.lock.acquire()
    cleanup = asyncio.create_task(manager.cleanup_worker(worker, 0))
    await asyncio.sleep(0)  # Cleanup queues first on the ledger lock.
    running = asyncio.create_task(manager.handle_worker_message(worker, {"type": "job.running", **worker.identity}))
    await asyncio.sleep(0)
    manager.ledger.lock.release()
    await asyncio.gather(cleanup, running)
    assert not manager.instances and not manager.ledger.reservations
    assert not any(call.args[0]["type"] == "job.running" for call in manager.send_control.call_args_list)


@pytest.mark.asyncio
@pytest.mark.skipif(os.getenv("RUN_GPU_SHARING_TESTS") != "1", reason="Opt-in local CUDA process test")
async def test_real_cuda_budget_sharing_and_overrun_isolates_other_job(tmp_path, monkeypatch):
    gpu_python = Path(os.getenv("CAEMBLE_GPU_TEST_PYTHON") or
        str(Path(__file__).resolve().parents[2] / "slaves" / "ai" / ".venv" / "Scripts" / "python.exe"))
    if not gpu_python.is_file():
        pytest.skip("Set CAEMBLE_GPU_TEST_PYTHON to an SDK/CUDA Torch environment")
    gpus = discover_gpus()
    eligible = [gpu for gpu in gpus if gpu["free_bytes"] * 2 > gpu["total_bytes"]]
    cpus = psutil.Process().cpu_affinity()
    if not eligible or len(cpus) < 3:
        pytest.skip("Requires a GPU below 50% usage and three available CPUs")
    device = eligible[0]["uuid"]
    (tmp_path / "gpu_fixture.py").write_text(
        "import json,os,sys,subprocess\nimport torch\n"
        "identity=json.loads(os.environ['CAEMBLE_EXECUTION_JSON'])['identity']\n"
        "def emit(kind,**values): print(json.dumps({'type':kind,**identity,**values}),flush=True)\n"
        "emit('worker.ready')\n"
        "for line in sys.stdin:\n"
        " message=json.loads(line)\n"
        " if message['type']=='job.start':\n"
        "  tensor=torch.ones(2*1024*1024,device='cuda')\n"
        "  assert tensor.sum().item()==2*1024*1024\n"
        "  torch.cuda.synchronize()\n"
        "  emit('job.running')\n"
        " elif message['type']=='fixture.allocate':\n"
        "  scratch=torch.ones(128*1024*1024,dtype=torch.uint8,device='cuda')\n"
        "  torch.cuda.synchronize()\n"
        " elif message['type']=='fixture.cache': del scratch\n"
        " elif message['type']=='fixture.flush': torch.cuda.empty_cache()\n"
        " elif message['type']=='fixture.grow':\n"
        "  child=subprocess.Popen([sys.executable,'-c',\"import torch,time; growth=torch.ones(768*1024*1024,dtype=torch.uint8,device='cuda'); torch.cuda.synchronize(); time.sleep(90)\"],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL)\n"
        " elif message['type']=='fixture.release':\n"
        "  assert tensor.sum().item()==2*1024*1024\n"
        "  emit('job.result',result={'ok':True})\n"
        "  emit('job.cleaned')\n"
        "  break\n"
        " elif message['type'] in ('stop','job.cancel'): break\n", encoding="utf-8")
    monkeypatch.setattr(SlaveApp, "python_executable", property(lambda _: gpu_python))
    ledger = ResourceLedger(ResourcePolicy(cpu_cores=3, gpu_devices=[device]), cpu_ids=cpus[:3])
    slave = SlaveApp("cae", "GPU fixture", "gpu_fixture", tmp_path, job_mode="websocket")
    settings = LauncherSettings(_env_file=None, api_url="http://localhost", access_token="fixture",
                                worker_ready_timeout_seconds=45)
    manager = WorkerManager(settings, AsyncMock(), SlaveAppRegistry([slave]), ledger=ledger)
    manager.launcher_id = "gpu-smoke"
    workers = []
    deadline = time.monotonic() + 150

    async def wait_until(predicate):
        while not predicate():
            assert time.monotonic() < deadline, manager.resource_report()
            await asyncio.sleep(0.1)

    try:
        await manager.initialize()
        offers = [offer(manager, index) for index in range(3)]
        for index, value in enumerate(offers):
            value["resources"] = {"cpu_cores": 1, "startup_ram_bytes": 256 * 1024**2,
                "vram_budget_gb": eligible[0]["total_bytes"] / GIB - 1 if index == 1 else 1}
        for index in range(2):
            await wait_until(lambda: ledger.gpu_report()[0]["admission_open"])
            await manager.reserve_job(offers[index])
            worker = manager.instances[offers[index]["instance_id"]]
            workers.append(worker)
            await manager.start_job({**offers[index], "type": "job.start", "allocation": worker.allocation,
                                    "websocket_url": "ws://localhost/fixture", "token": "fixture"})
            await wait_until(lambda: worker.status == "running" or worker.terminal is not None)
            assert worker.terminal is None, worker.terminal
            if index == 0:
                await wait_until(lambda: ledger.gpu_report()[0]["admission_open"])
                baseline = worker.vram_used_bytes[device]
                assert baseline > 0  # CUDA context is charged, not just tensors.
                for _ in range(2):
                    await manager.write_worker(worker, {"type": "fixture.allocate"})
                    await wait_until(lambda: worker.vram_used_bytes is not None
                                     and worker.vram_used_bytes[device] >= baseline + 100*1024**2)
                    await manager.write_worker(worker, {"type": "fixture.cache"})
                    await asyncio.sleep(1.2)
                    assert worker.vram_used_bytes[device] >= baseline + 100*1024**2
                    await manager.write_worker(worker, {"type": "fixture.flush"})
                    await wait_until(lambda: worker.vram_used_bytes is not None
                                     and worker.vram_used_bytes[device] < baseline + 32*1024**2)
        assert all(worker.process.returncode is None for worker in workers)
        assert all(worker.allocation["gpu_devices"] == [device] for worker in workers)
        assert ledger.gpu_report()[0]["job_count"] == 2
        await wait_until(lambda: ledger.gpu_report()[0]["waiting_reason"] == "gpu_budget_unavailable")
        await manager.reserve_job(offers[2])
        assert len(manager.instances) == 2
        await manager.write_worker(workers[0], {"type": "fixture.release"})
        await wait_until(lambda: offers[0]["instance_id"] not in manager.instances)
        assert workers[0].process.returncode == 0
        assert workers[1].process.returncode is None
        await wait_until(lambda: ledger.gpu_report()[0]["admission_open"])
        await manager.reserve_job(offers[2])
        third = manager.instances[offers[2]["instance_id"]]
        workers.append(third)
        await manager.start_job({**offers[2], "type": "job.start", "allocation": third.allocation,
                                "websocket_url": "ws://localhost/fixture", "token": "fixture"})
        await wait_until(lambda: third.status == "running" or third.terminal is not None)
        assert third.terminal is None, third.terminal
        await manager.write_worker(third, {"type": "fixture.grow"})
        await wait_until(lambda: len(third.container.pids()) > 1 or third.terminal is not None)
        child_pids = set(third.container.pids()) - {third.process.pid}
        assert child_pids
        await wait_until(lambda: third.identity["instance_id"] not in manager.instances)
        assert third.terminal["code"] == "gpu_memory_budget_exceeded"
        assert workers[1].process.returncode is None
        await manager.write_worker(workers[1], {"type": "fixture.release"})
        await wait_until(lambda: not manager.instances)
        assert not ledger.reservations
        assert all(worker.process.returncode == 0 for worker in workers[:2])
        assert all(worker.terminal["type"] == "job.result" for worker in workers[:2])
        assert third.process.returncode is not None
        assert not any(psutil.pid_exists(pid) for pid in child_pids)
    finally:
        await manager.close()
        assert not manager.instances
        assert all(worker.container is None or worker.container.closed for worker in workers)
