"""Backpressured IPC and forced-exit workspace cleanup use the normal child ABI."""

from tests.executor_transport_fixtures import _partial_frame

import asyncio
from dataclasses import replace
import multiprocessing
from multiprocessing.connection import Connection
from pathlib import Path
import socket
import threading
import time

import numpy as np
import pytest

from app.kernel.api import SolverResourceServices
from app.kernel.execution import (
    MmapPayloadCodec, SolverExecutionCancelled, SolverProcessExitedError, SpawnSolverExecutor,
)
from app.kernel.resources import BufferStore
from tests.solver_test_support import invocation


@pytest.mark.asyncio
async def test_shutdown_deadline_bounds_incomplete_pipe_frame():
    context = multiprocessing.get_context("spawn")
    ready = context.Event()
    receiving, sending = socket.socketpair()
    receive_connection = Connection(receiving.detach(), writable=False)
    send_connection = Connection(sending.detach(), readable=False)
    process = context.Process(target=_partial_frame, args=(send_connection, ready))
    process.start()
    send_connection.close()
    executor = SpawnSolverExecutor(cancellation_grace=.05)

    async def emergency_stop():
        # Bound a regression failure as well: an unbounded recv must fail the
        # timing assertion instead of leaving a child or thread behind.
        await asyncio.sleep(2)
        if process.is_alive():
            process.terminate()

    watchdog = None
    try:
        assert await asyncio.to_thread(ready.wait, 10)
        assert receive_connection.poll()
        watchdog = asyncio.create_task(emergency_stop())
        started = time.monotonic()
        await executor._stop_process(process, .05, receive_connection, threading.Lock())
        assert time.monotonic() - started < 1
        assert not process.is_alive()
    finally:
        if watchdog is not None:
            watchdog.cancel()
            await asyncio.gather(watchdog, return_exceptions=True)
        if process.is_alive():
            process.terminate()
        await asyncio.to_thread(process.join, 5)
        receive_connection.close()
        process.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["signal", "task"])
async def test_cancellation_drains_blocked_progress_and_preserves_caller_directory(tmp_path, mode):
    caller_directory = tmp_path / "caller-owned"
    caller_directory.mkdir()
    sentinel = caller_directory / "keep.txt"
    sentinel.write_text("keep", encoding="utf-8")
    observed = tmp_path / "cooperative.txt"
    context = replace(invocation({"observed": str(observed), "values": np.arange(4096)}),
                      resources=SolverResourceServices(workspace_path=str(caller_directory)))
    store = BufferStore(tmp_path / "buffers")
    executor = SpawnSolverExecutor(codec=MmapPayloadCodec(store, array_threshold=128), cancellation_grace=1)
    cancellation = asyncio.Event()
    workspaces = []
    task = None

    async def progress(value):
        if value.get("stage") == "ready":
            workspaces.append(Path(value["workspace"]))
            assert workspaces[-1] != caller_directory
            assert (workspaces[-1] / "numerical-scratch").exists()
            await asyncio.sleep(.15)
            if mode == "signal":
                cancellation.set()
            else:
                task.cancel()

    try:
        task = asyncio.create_task(executor.execute("tests.executor_transport_fixtures:flooding", context,
                                                    progress=progress, cancellation=cancellation))
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=15)
        await executor.wait_for_cleanup()
        assert observed.read_text(encoding="utf-8") == "cooperative cancellation"
        assert len(workspaces) == 1 and not workspaces[0].exists()
        assert sentinel.read_text(encoding="utf-8") == "keep"
        assert context.resources.workspace_path == str(caller_directory)
        assert store.files() == ()
    finally:
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["forced_exit", "crashes"])
async def test_parent_removes_exact_workspace_after_noncooperative_exit(tmp_path, failure):
    store = BufferStore(tmp_path / "buffers")
    executor = SpawnSolverExecutor(codec=MmapPayloadCodec(store, array_threshold=128), cancellation_grace=.05)
    cancellation = asyncio.Event()
    workspaces = []

    async def progress(value):
        if value.get("stage") == "ready":
            workspaces.append(Path(value["workspace"]))
            assert (workspaces[-1] / "numerical-scratch").exists()
            if failure == "forced_exit":
                cancellation.set()

    try:
        error = SolverExecutionCancelled if failure == "forced_exit" else SolverProcessExitedError
        with pytest.raises(error):
            await executor.execute(f"tests.executor_transport_fixtures:{failure}", invocation({"values": np.arange(4096)}),
                                   progress=progress, cancellation=cancellation, timeout=10)
        await executor.wait_for_cleanup()
        assert len(workspaces) == 1 and not workspaces[0].exists()
        assert store.files() == ()
    finally:
        store.close()
