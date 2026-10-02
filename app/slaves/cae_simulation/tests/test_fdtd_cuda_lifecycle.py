"""Real CPU/CUDA children, host mmap rollback and process-owned GPU cleanup."""
import asyncio
from dataclasses import replace
import gc
from pathlib import Path
import threading
import time

import numpy as np
import psutil
import pytest
import torch

from app.kernel.execution import MmapPayloadCodec, SolverExecutionCancelled, SpawnSolverExecutor
from app.kernel.resources import BufferStore
from sdk.gpu_memory import GpuProcessMonitor
from sdk.process_metrics import ProcessMetrics
from tests.fdtd_cuda_fixtures import cuda_fdtd_child
from tests.fdtd_fixtures import small_fdtd_invocation


pytestmark = [pytest.mark.cuda, pytest.mark.skipif(not torch.cuda.is_available(), reason="CUDA device is unavailable")]


@pytest.mark.asyncio
async def test_actual_cuda_child_matches_cpu_and_releases_workspace():
    cpu = await SpawnSolverExecutor(cpu_budget=1).execute(
        "app.solvers.fdtd.entry:implementation", small_fdtd_invocation(), timeout=60)
    store, events = BufferStore(), []
    executor = SpawnSolverExecutor(codec=MmapPayloadCodec(store, array_threshold=1), cpu_budget=1)
    executor._child_target = cuda_fdtd_child
    root = store.root
    try:
        gpu = await executor.execute("app.solvers.fdtd.entry:implementation", small_fdtd_invocation(),
                                     progress=events.append, timeout=60)
        assert cpu.observations["device"] == "cpu" and gpu.observations["device"].startswith("cuda")
        assert gpu.observations["timeSteps"] == cpu.observations["timeSteps"]
        for name, value in cpu.artifacts.items():
            reference, actual = value["value"], gpu.artifacts[name]["value"]
            assert np.isfinite(actual).all() and np.any(reference != 0)
            relative = np.linalg.norm(actual - reference) / np.linalg.norm(reference)
            assert relative < 1e-5
        ready = next(event for event in events if event.get("stage") == "cuda-ready")
        child = next(event for event in events if event.get("stage") == "cuda-child")
        assert ready["allocatedBytes"] > 0 and not psutil.pid_exists(child["pid"])
        assert not Path(child["workspace"]).exists()
        del gpu, actual
        gc.collect()
    finally:
        await executor.wait_for_cleanup()
        store.close()
    assert not root.exists()


@pytest.mark.asyncio
async def test_actual_cuda_cancellation_releases_gpu_and_mmap():
    device = str(torch.cuda.get_device_properties(0).uuid)
    device = device if device.startswith("GPU-") else "GPU-" + device
    monitor = GpuProcessMonitor()
    try:
        monitor.sample([device])
    except Exception as error:
        monitor.close()
        pytest.skip(f"Per-process GPU memory measurement unavailable: {error}")
    store, cancelled, events = BufferStore(), threading.Event(), []
    executor = SpawnSolverExecutor(codec=MmapPayloadCodec(store, array_threshold=1), cpu_budget=1)
    executor._child_target = cuda_fdtd_child
    invocation = replace(small_fdtd_invocation(), state={"inputBuffer": np.arange(4096, dtype=np.float32)})
    invocation.config["parameters"]["simulationTime"]["value"] = 4e-3
    invocation.config["outputs"] = []
    root = store.root
    observed_usage = 0

    async def progress(value):
        nonlocal observed_usage
        events.append(value)
        if value.get("stage") == "cuda-ready":
            assert store.files(), "Cancellation fixture must own a live mmap input"
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                usage = await asyncio.to_thread(monitor.sample, [device])
                observed_usage = usage[device].get(value["pid"], 0)
                if observed_usage > 0:
                    break
                await asyncio.sleep(.05)
            cancelled.set()

    try:
        with ProcessMetrics([device]) as metrics:
            with pytest.raises(SolverExecutionCancelled):
                await executor.execute("app.solvers.fdtd.entry:implementation", invocation,
                                       progress=progress, cancellation=cancelled, timeout=45)
            await executor.wait_for_cleanup()
        child = next(event for event in events if event.get("stage") == "cuda-child")
        assert observed_usage > 0, "CUDA allocation was not observed by the OS GPU monitor"
        assert not psutil.pid_exists(child["pid"]) and not Path(child["workspace"]).exists()
        assert store.files() == ()
        deadline, residual = time.monotonic() + 5, observed_usage
        while residual and time.monotonic() < deadline:
            usage = await asyncio.to_thread(monitor.sample, [device])
            residual = usage[device].get(child["pid"], 0)
            if residual:
                await asyncio.sleep(.05)
        assert residual == 0, "Cancelled child retained GPU memory"
        assert metrics.result["rssStatus"] == "measured"
    finally:
        cancelled.set()
        await executor.wait_for_cleanup()
        monitor.close()
        store.close()
    assert not root.exists()
