import asyncio
from pathlib import Path
from types import SimpleNamespace

import psutil
import pytest

from app.kernel.execution import SpawnSolverExecutor
from app.kernel.execution.cpu import cpu_allocation
from tests.solver_test_support import invocation


@pytest.mark.parametrize("available,expected", [(1, 1), (2, 1), (5, 2), (6, 3)])
def test_default_cpu_budget_respects_affinity(monkeypatch, available, expected):
    monkeypatch.delenv("CAEMBLE_CAE_CPU_BUDGET", raising=False)
    monkeypatch.setattr(psutil, "Process", lambda: SimpleNamespace(cpu_affinity=lambda: list(range(available))))
    assert cpu_allocation().budget == expected


def test_explicit_cpu_budget_and_invalid_values(monkeypatch):
    monkeypatch.setattr(psutil, "Process", lambda: SimpleNamespace(cpu_affinity=lambda: [0, 1, 2]))
    monkeypatch.setenv("CAEMBLE_CAE_CPU_BUDGET", "8")
    assert cpu_allocation().budget == 3
    assert cpu_allocation(1).budget == 1
    for invalid in ("0", "-1", "1.5", "", "auto"):
        monkeypatch.setenv("CAEMBLE_CAE_CPU_BUDGET", invalid)
        with pytest.raises(ValueError, match="positive integer"):
            cpu_allocation()


def test_cpu_count_fallback(monkeypatch):
    import os
    monkeypatch.delenv("CAEMBLE_CAE_CPU_BUDGET", raising=False)
    monkeypatch.setattr(psutil, "Process", lambda: SimpleNamespace())
    monkeypatch.setattr(os, "cpu_count", lambda: None)
    assert cpu_allocation().budget == 1


def test_batch_memory_reduces_workers(monkeypatch):
    from app.kernel.api import CpuAllocation
    from app.kernel.execution.batches import ChildExecutionService
    service = object.__new__(ChildExecutionService)
    service.cpu = CpuAllocation(8, 4)
    monkeypatch.setattr(psutil, "virtual_memory", lambda: SimpleNamespace(available=1200))
    assert service.batch_workers(8, 200) == 3
    assert service.batch_workers(8, 1000) == 1
    assert service.batch_workers(2, 0) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("repeats", [1, 2])
async def test_managed_batches_preserve_order_mmap_and_process_ownership(tmp_path, repeats):
    executor = SpawnSolverExecutor(cpu_budget=2)
    if executor.cpu.budget < 2:
        pytest.skip("requires two available CPUs")
    workspaces = []
    result = await executor.execute("tests.batch_fixtures:implementation", invocation({"directory": str(tmp_path), "repeats": repeats}),
                                    progress=lambda value: workspaces.append(Path(value["workspace"])), timeout=30)
    assert [item["index"] for item in result.artifacts["results"]] == list(range(7)) * repeats
    assert [item["first"] for item in result.artifacts["results"]] == list(range(7)) * repeats
    assert [item["last"] for item in result.artifacts["results"]] == [199999 + i for i in range(7)] * repeats
    pids = [int(path.stem) for path in tmp_path.glob("*.pid")]
    assert len(pids) == 2 * repeats and not any(psutil.pid_exists(pid) for pid in pids)
    import os
    assert {int(path.read_text()) for path in tmp_path.glob("*.pid")} == {os.getpid()}
    assert not any(path.exists() for path in workspaces)


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["initialize-error", "error", "crash", "solver-crash", "hang", "cooperative", "timeout"])
async def test_failed_batches_leave_no_workers_or_workspace(tmp_path, mode):
    executor = SpawnSolverExecutor(cpu_budget=2, cancellation_grace=.1)
    if executor.cpu.budget < 2:
        pytest.skip("requires two available CPUs")
    cancellation = asyncio.Event()
    workspaces = []
    task = asyncio.create_task(executor.execute(
        "tests.batch_fixtures:implementation", invocation({"directory": str(tmp_path), "mode": "hang" if mode == "timeout" else mode}),
        progress=lambda value: workspaces.append(Path(value["workspace"])), cancellation=cancellation,
        timeout=3 if mode == "timeout" else 20))
    if mode in {"hang", "cooperative"}:
        async with asyncio.timeout(15):
            while len(list(tmp_path.glob("*.pid"))) < 2:
                await asyncio.sleep(.02)
        cancellation.set()
    with pytest.raises((Exception, asyncio.CancelledError)):
        await asyncio.wait_for(task, 30)
    await executor.wait_for_cleanup()
    assert not any(psutil.pid_exists(int(path.stem)) for path in tmp_path.glob("*.pid"))
    assert not any(path.exists() for path in workspaces)


@pytest.mark.asyncio
async def test_torch_threads_initialized_once_in_fresh_child():
    executor = SpawnSolverExecutor(cpu_budget=2)
    result = await executor.execute("tests.batch_fixtures:torch_implementation", invocation(), timeout=30)
    assert result.observations == {"intra": executor.cpu.budget, "inter": 1}


@pytest.mark.asyncio
async def test_cancel_during_spawn_does_not_start_remaining_batch_workers(tmp_path, monkeypatch):
    import multiprocessing
    import time
    from app.kernel.execution import executor as module

    executor = SpawnSolverExecutor(cpu_budget=2, cancellation_grace=.05)
    if executor.cpu.budget < 2:
        pytest.skip("requires two CPUs")
    baseline = {child.pid for child in multiprocessing.active_children()}
    cancellation = asyncio.Event()
    loop = asyncio.get_running_loop()
    started = []
    original = module._start_process

    def slow_start(process):
        original(process)
        if process.name.startswith("caemble-batch:"):
            started.append(process.pid)
            loop.call_soon_threadsafe(cancellation.set)
            time.sleep(.2)

    monkeypatch.setattr(module, "_start_process", slow_start)
    with pytest.raises(asyncio.CancelledError):
        await executor.execute("tests.batch_fixtures:implementation", invocation({"directory": str(tmp_path)}),
                               cancellation=cancellation, timeout=20)
    assert len(started) == 1
    assert {child.pid for child in multiprocessing.active_children()} == baseline
    assert not any(psutil.pid_exists(pid) for pid in started)
