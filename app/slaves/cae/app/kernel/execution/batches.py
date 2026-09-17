"""Resident-owned spawn workers with direct, bounded child-to-worker data pipes.

Only locators, connections and codec metadata pass through the resident. Solver
objects are encoded/decoded exclusively in the computation processes.
"""
from __future__ import annotations

import asyncio
import gc
import importlib
import multiprocessing
import time
import traceback
from pathlib import Path

import psutil

from app.kernel.execution.cpu import NativeThreads
from app.kernel.execution.serialization import MmapPayloadCodec
from app.kernel.resources.buffers import BufferStore
from sdk.slave.io import log


def batch_worker(connection, cancellation) -> None:
    from app.kernel.execution.child import ProcessCancellationToken

    threads = NativeThreads(1)
    token = ProcessCancellationToken(cancellation)
    prepared = None
    prepared_codec = None
    codec = None
    try:
        initializer, function, prepared_codec, payload = connection.recv()
        module, attribute = initializer.split(":")
        initialize = getattr(importlib.import_module(module), attribute)
        module, attribute = function.split(":")
        compute = getattr(importlib.import_module(module), attribute)
        threads.apply(1)
        prepared = initialize(prepared_codec.decode(payload))
        connection.send(("ready", None))
        while True:
            task = connection.recv()
            if task is None:
                break
            codec, payload = task
            token.raise_if_cancelled()
            started = time.perf_counter()
            result = compute(prepared, codec.decode(payload), token)
            connection.send(("result", codec.encode(result), time.perf_counter() - started))
            result = None
            codec.buffer_store.close()
            codec = None
    except (EOFError, BrokenPipeError):
        pass
    except BaseException:
        try:
            connection.send(("error", traceback.format_exc()))
        except (EOFError, OSError):
            pass
    finally:
        prepared = None
        gc.collect()
        if codec is not None:
            codec.buffer_store.close()
        if prepared_codec is not None:
            prepared_codec.buffer_store.close()
        connection.close()


class ResidentBatchRuntime:
    """Own every process and intermediate buffer until all readers have exited."""

    def __init__(self, connection, cancellation, workspace, budget, start_process,
                 cancellation_grace=.5, exit_grace=1.0):
        self.connection = connection
        self.cancellation = cancellation
        self.workspace = Path(workspace)
        self.budget = budget
        self.start_process = start_process
        self.cancellation_grace = cancellation_grace
        self.exit_grace = exit_grace
        self.processes = []
        self.connections = []
        self.store = None
        self.codecs = {}
        self.stopping = False
        self._close_lock = asyncio.Lock()

    async def serve(self):
        try:
            while not self.stopping:
                if not self.connection.poll():
                    await asyncio.sleep(.005)
                    continue
                request = await asyncio.to_thread(self.connection.recv)
                command = request[0]
                if command == "open":
                    count = request[1]
                    if self.store is not None or not 1 <= count <= self.budget:
                        raise RuntimeError("invalid batch pool allocation")
                    self.store = BufferStore(self.workspace / "batch-buffers")
                    context = multiprocessing.get_context("spawn")
                    endpoints = []
                    for index in range(count):
                        if self.stopping or self.cancellation.is_set():
                            return
                        client, worker = context.Pipe()
                        self.connections.extend((client, worker))
                        process = context.Process(target=batch_worker, args=(worker, self.cancellation),
                                                  name=f"caemble-batch:{index}")
                        self.processes.append(process)
                        # Track before starting; executor cleanup also waits for
                        # this serve task if spawn is still finishing.
                        await asyncio.to_thread(self.start_process, process)
                        worker.close()
                        endpoints.append(client)
                    prepared_codec = MmapPayloadCodec(self.store).begin_invocation()
                    self.codecs[prepared_codec.transaction_id] = prepared_codec
                    await asyncio.to_thread(self.connection.send, (endpoints, prepared_codec))
                    for endpoint in endpoints:
                        endpoint.close()
                    log(f"solver batch pool workers={count} native_threads=1 pids={[p.pid for p in self.processes]}")
                elif command == "begin":
                    codec = MmapPayloadCodec(self.store).begin_invocation()
                    self.codecs[codec.transaction_id] = codec
                    await asyncio.to_thread(self.connection.send, codec)
                elif command == "release":
                    self.codecs.pop(request[1]).rollback()
                    await asyncio.to_thread(self.connection.send, None)
                elif command == "close":
                    await self.close()
                    await asyncio.to_thread(self.connection.send, None)
                elif command == "stop":
                    await self.stop_workers()
                    await asyncio.to_thread(self.connection.send, None)
                else:
                    raise RuntimeError(f"unknown batch command {command!r}")
        except (EOFError, OSError):
            pass

    async def close(self):
        await self.stop_workers()
        if self.store is not None:
            self.store.close()
            self.store = None
        self.codecs.clear()

    async def stop_workers(self):
        async with self._close_lock:
            deadline = time.monotonic() + self.cancellation_grace
            while any(p.pid is not None and p.is_alive() for p in self.processes) and time.monotonic() < deadline:
                await asyncio.sleep(.01)
            for process in self.processes:
                if process.pid is not None and process.is_alive():
                    process.terminate()
            for process in self.processes:
                if process.pid is None:
                    continue
                await asyncio.to_thread(process.join, self.exit_grace)
                if process.is_alive():
                    process.kill()
                    await asyncio.to_thread(process.join)
                process.close()
            self.processes.clear()
            for connection in self.connections:
                connection.close()
            self.connections.clear()


class ChildExecutionService:
    def __init__(self, connection, cancellation, cpu):
        self.connection = connection
        self.cancellation = cancellation
        self.cpu = cpu
        self.threads = NativeThreads(cpu.budget)
        self._rpc_lock = asyncio.Lock()
        self._pool_active = False

    def configure_torch(self):
        self.threads.configure_torch()

    def batch_workers(self, requested, private_bytes):
        count = min(requested, self.cpu.budget)
        if private_bytes:
            count = min(count, max(1, (psutil.virtual_memory().available // 2) // private_bytes))
        return max(1, count)

    async def _rpc(self, *request):
        async with self._rpc_lock:
            await asyncio.to_thread(self.connection.send, request)
            return await asyncio.to_thread(self.connection.recv)

    async def map_batches(self, initializer, function, prepared, batches, workers):
        if self._pool_active:
            raise RuntimeError("nested batch pools are not supported")
        self._pool_active = True
        self.threads.apply(1)
        endpoints = []
        prepared_codec = None
        pending = {}
        ready = {}
        live_codecs = {}
        started = time.perf_counter()
        compute_seconds = 0.0
        overhead_seconds = 0.0
        try:
            endpoints, prepared_codec = await self._rpc("open", workers)
            payload = prepared_codec.encode(prepared)

            async def initialize(endpoint):
                await asyncio.to_thread(endpoint.send, (initializer, function, prepared_codec, payload))
                response = await asyncio.to_thread(endpoint.recv)
                if response[0] != "ready":
                    raise RuntimeError(f"batch initialization failed: {response[1]}")

            await asyncio.gather(*(initialize(endpoint) for endpoint in endpoints))
            log(f"solver batch setup seconds={time.perf_counter() - started:.6f}")
            iterator = iter(batches)
            idle = list(endpoints)
            submitted = next_result = 0
            exhausted = False

            async def execute(endpoint, batch):
                batch_started = time.perf_counter()
                codec = await self._rpc("begin")
                live_codecs[codec.transaction_id] = codec
                payload = codec.encode(batch)
                await asyncio.to_thread(endpoint.send, (codec, payload))
                try:
                    response = await asyncio.to_thread(endpoint.recv)
                except EOFError as exc:
                    raise RuntimeError("batch worker exited without a result") from exc
                if response[0] != "result":
                    raise RuntimeError(f"batch computation failed: {response[1]}")
                result = codec.decode(response[1])
                return codec, result, response[2], time.perf_counter() - batch_started - response[2]

            while pending or ready or not exhausted:
                self.cancellation.raise_if_cancelled()
                while idle and not exhausted and submitted - next_result < 2 * workers:
                    try:
                        batch = next(iterator)
                    except StopIteration:
                        exhausted = True
                        break
                    endpoint = idle.pop()
                    task = asyncio.create_task(execute(endpoint, batch))
                    pending[task] = (submitted, endpoint)
                    submitted += 1
                while next_result in ready:
                    codec, result, seconds, overhead = ready.pop(next_result)
                    compute_seconds += seconds
                    overhead_seconds += overhead
                    yield result
                    result = None
                    codec.buffer_store.close()
                    await self._rpc("release", codec.transaction_id)
                    live_codecs.pop(codec.transaction_id)
                    next_result += 1
                if idle and not exhausted and submitted - next_result < 2 * workers:
                    continue
                if pending:
                    done, _ = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        index, endpoint = pending.pop(task)
                        ready[index] = task.result()
                        idle.append(endpoint)
            for endpoint in endpoints:
                await asyncio.to_thread(endpoint.send, None)
            log(f"solver batches count={submitted} compute_worker_seconds={compute_seconds:.6f} "
                f"overhead_worker_seconds={overhead_seconds:.6f} "
                f"total_seconds={time.perf_counter() - started:.6f}")
        except BaseException:
            self.cancellation.cancel()
            raise
        finally:
            # Stop/kill readers before closing mmap files, even if a worker is
            # stuck in native code or in a partially written pipe frame.
            try:
                await self._rpc("stop")
            finally:
                await asyncio.gather(*pending, return_exceptions=True)
                ready.clear()
                for codec in live_codecs.values():
                    codec.buffer_store.close()
                if prepared_codec is not None:
                    prepared_codec.buffer_store.close()
                for endpoint in endpoints:
                    endpoint.close()
                await self._rpc("close")
                self.threads.apply(self.cpu.budget)
                self._pool_active = False
