from __future__ import annotations

import asyncio
import multiprocessing
import os
import pickle
import subprocess
import sys
import time
import unittest
from collections.abc import Awaitable
from typing import Any

import numpy as np

from app.runtime_kernel.api import InputArtifact, SolverInvocation, SolverResult
from app.runtime_kernel.execution import (
    RemoteSolverError,
    SolverExecutionCancelled,
    SolverExecutionStartupTimeout,
    SolverExecutionTimeout,
    SolverPayloadError,
    SolverProcessExitedError,
    SpawnSolverExecutor,
)
from app.solver_framework.geometry import GeometryService
from app.solver_framework.models import SolverContext
from tests.executor_transport_fixtures import (
    SlowInvocationDecodeCodec,
    SlowPicklePayloadCodec,
    closes_request_after_bootstrap,
    exits_before_bootstrap,
    never_starts,
)

_FIXTURES = "tests.spawn_executor_fixtures"


class SpawnSolverExecutorTests(unittest.IsolatedAsyncioTestCase):
    async def _run_with_heartbeat(self, awaitable: Awaitable[Any]) -> tuple[Any, int]:
        ticks = 0
        running = True

        async def heartbeat() -> None:
            nonlocal ticks
            while running:
                ticks += 1
                await asyncio.sleep(0.01)

        heartbeat_task = asyncio.create_task(heartbeat())
        try:
            return await awaitable, ticks
        finally:
            running = False
            await heartbeat_task

    async def test_legacy_async_runner_transports_numpy_and_progress(self) -> None:
        self.assertNotIn(_FIXTURES, sys.modules)
        progress: list[dict[str, object]] = []
        context = SolverContext(
            config={"gain": 3.0},
            state={"step": 2},
            inputs={"values": np.asarray([1.0, 2.0, 3.0])},
            world={},
            geometry=GeometryService(),
            # The executor strips this unpicklable callback before spawn.
            progress=lambda _: None,
            descriptor={},
        )

        result = await SpawnSolverExecutor().execute(
            f"{_FIXTURES}:legacy_run",
            context,
            progress=progress.append,
        )

        np.testing.assert_array_equal(result["outputs"]["values"], [3.0, 6.0, 9.0])
        self.assertEqual(result["state"], {"step": 2})
        self.assertNotEqual(result["pid"], os.getpid())
        self.assertEqual(progress[0]["stage"], "fixture")
        self.assertNotIn(_FIXTURES, sys.modules)

    async def test_each_invocation_uses_a_distinct_child(self) -> None:
        executor = SpawnSolverExecutor()

        def context() -> SolverContext:
            return SolverContext(
                config={"gain": 1},
                state={},
                inputs={"values": np.asarray([1])},
                world={},
                geometry=GeometryService(),
                progress=lambda _: None,
                descriptor={},
            )

        first, second = await asyncio.gather(
            executor.execute(f"{_FIXTURES}:legacy_run", context()),
            executor.execute(f"{_FIXTURES}:legacy_run", context()),
        )

        self.assertNotEqual(first["pid"], second["pid"])

    async def test_detects_abi_v2_implementation_by_duck_typing(self) -> None:
        progress: list[dict[str, object]] = []
        result = await SpawnSolverExecutor().execute(
            f"{_FIXTURES}:v2_implementation",
            {"state": {"branch": "a"}},
            progress=progress.append,
        )

        self.assertEqual(result["state"], {"branch": "a"})
        self.assertEqual(result["outputs"], {"abiVersion": 2})
        self.assertEqual(progress, [{"stage": "abi-v2"}])

    async def test_catalog_abi_must_match_the_child_entry(self) -> None:
        with self.assertRaises(RemoteSolverError) as raised:
            await SpawnSolverExecutor().execute(
                f"{_FIXTURES}:legacy_run",
                {},
                abi_version=2,
            )

        self.assertIn("Catalog declares ABI 2", str(raised.exception))

    async def test_legacy_locator_adapts_abi_v2_invocation_inside_child(self) -> None:
        progress: list[dict[str, object]] = []
        invocation = SolverInvocation(
            config={},
            state={"step": 1},
            inputs={
                "source": InputArtifact(
                    "artifact-1",
                    "test/scalar@1",
                    "producer",
                    "producer-solver",
                    "1.0.0",
                    "source",
                    1,
                    None,
                    3.0,
                )
            },
            world={},
            geometry=None,
            progress=None,
            descriptor={},
        )

        result = await SpawnSolverExecutor().execute(
            f"{_FIXTURES}:legacy_solver_context",
            invocation,
            progress=progress.append,
        )

        self.assertIsInstance(result, SolverResult)
        self.assertTrue(result.state_patch.is_empty)
        self.assertEqual(result.artifacts["value"], 6.0)
        self.assertEqual(progress, [{"stage": "legacy-adapter"}])

    async def test_legacy_in_place_state_mutation_becomes_a_patch(self) -> None:
        invocation = SolverInvocation(
            config={},
            state={"step": 1},
            inputs={},
            world={},
            geometry=None,
            progress=None,
            descriptor={},
        )

        result = await SpawnSolverExecutor().execute(
            f"{_FIXTURES}:legacy_mutates_state",
            invocation,
            abi_version=1,
        )

        self.assertIsInstance(result, SolverResult)
        self.assertFalse(result.state_patch.is_empty)
        self.assertEqual(result.state_patch.operations[0].value, {"step": 2})

    async def test_remote_exception_contains_child_traceback(self) -> None:
        with self.assertRaises(RemoteSolverError) as raised:
            await SpawnSolverExecutor().execute(
                f"{_FIXTURES}:raises_error",
                {},
            )

        self.assertEqual(raised.exception.remote.name, "ValueError")
        self.assertIn("fixture solver failed", str(raised.exception))
        self.assertIn("raises_error", raised.exception.remote.traceback)

    async def test_explicit_cancellation_stops_child(self) -> None:
        cancellation = asyncio.Event()
        task = asyncio.create_task(
            SpawnSolverExecutor(cancellation_grace=0.1).execute(
                f"{_FIXTURES}:wait_for_cancellation",
                {"cancellation": None},
                cancellation=cancellation,
            )
        )
        await asyncio.sleep(0.1)
        cancellation.set()

        with self.assertRaises(SolverExecutionCancelled):
            await task

    async def test_timeout_terminates_non_cooperative_child(self) -> None:
        with self.assertRaises(SolverExecutionTimeout):
            await SpawnSolverExecutor(cancellation_grace=0.05).execute(
                f"{_FIXTURES}:blocks_forever",
                {},
                timeout=0.1,
            )

    async def test_exact_64384_byte_invocation_repeatedly_bootstraps(self) -> None:
        context = {"payload": b"x" * 64_353}
        self.assertEqual(
            len(pickle.dumps(context, protocol=pickle.HIGHEST_PROTOCOL)),
            64_384,
        )
        executor = SpawnSolverExecutor()

        for _ in range(3):
            result = await executor.execute(f"{_FIXTURES}:payload_size", context)
            self.assertEqual(result["size"], 64_353)
            self.assertNotEqual(result["pid"], os.getpid())

    @unittest.skipUnless(sys.platform == "win32", "Windows stdin inheritance test")
    async def test_resident_stdin_reader_does_not_block_child_bootstrap(self) -> None:
        process = subprocess.Popen(
            [sys.executable, "-m", "tests.resident_spawn_probe"],
            cwd=os.path.dirname(os.path.dirname(__file__)),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            await asyncio.to_thread(process.wait, 10)
        except subprocess.TimeoutExpired:
            process.kill()
            await asyncio.to_thread(process.wait)
            self.fail("resident worker probe deadlocked during child bootstrap")

        assert process.stdout is not None
        assert process.stderr is not None
        stdout = process.stdout.read()
        stderr = process.stderr.read()
        self.assertEqual(process.returncode, 0, stderr)
        self.assertIn('"size": 64353', stdout)
        self.assertIn("solver child bootstrapped", stderr)

    async def test_32mb_invocation_crosses_post_bootstrap_request_pipe(self) -> None:
        context = {"payload": b"x" * (32 * 1024 * 1024)}
        encoded = pickle.dumps(context, protocol=pickle.HIGHEST_PROTOCOL)
        self.assertGreaterEqual(len(encoded), 32 * 1024 * 1024)

        executor = SpawnSolverExecutor()
        for _ in range(2):
            result = await executor.execute(f"{_FIXTURES}:payload_size", context)
            self.assertEqual(result["size"], 32 * 1024 * 1024)

    async def test_slow_codec_does_not_block_event_loop_heartbeat(self) -> None:
        result, ticks = await self._run_with_heartbeat(
            SpawnSolverExecutor(codec=SlowPicklePayloadCodec()).execute(
                f"{_FIXTURES}:payload_size",
                {"payload": b"value"},
            )
        )

        self.assertEqual(result["size"], 5)
        self.assertGreaterEqual(ticks, 20)

    async def test_solver_timeout_begins_only_after_child_decodes_invocation(self) -> None:
        result = await SpawnSolverExecutor(
            codec=SlowInvocationDecodeCodec(delay=2.5)
        ).execute(
            f"{_FIXTURES}:payload_size",
            {"payload": b"value"},
            timeout=2.0,
        )

        self.assertEqual(result["size"], 5)

    @unittest.skipUnless(sys.platform == "win32", "Windows spawn implementation test")
    async def test_slow_process_start_does_not_block_event_loop_heartbeat(self) -> None:
        from multiprocessing import popen_spawn_win32

        original_init = popen_spawn_win32.Popen.__init__

        def slow_init(instance: object, *args: object, **kwargs: object) -> None:
            time.sleep(0.25)
            original_init(instance, *args, **kwargs)

        popen_spawn_win32.Popen.__init__ = slow_init
        try:
            result, ticks = await self._run_with_heartbeat(
                SpawnSolverExecutor().execute(
                    f"{_FIXTURES}:payload_size",
                    {"payload": b"value"},
                )
            )
        finally:
            popen_spawn_win32.Popen.__init__ = original_init

        self.assertEqual(result["size"], 5)
        self.assertGreaterEqual(ticks, 10)

    async def test_child_exit_before_bootstrap_is_reported_and_reaped(self) -> None:
        baseline = {child.pid for child in multiprocessing.active_children()}
        executor = SpawnSolverExecutor()
        executor._child_target = exits_before_bootstrap

        with self.assertRaises(SolverProcessExitedError) as raised:
            await executor.execute("unused:solver", {})

        self.assertEqual(raised.exception.exit_code, 29)
        self.assertEqual(
            {child.pid for child in multiprocessing.active_children()},
            baseline,
        )

    async def test_request_send_failure_is_reported_and_reaped(self) -> None:
        baseline = {child.pid for child in multiprocessing.active_children()}
        executor = SpawnSolverExecutor()
        executor._child_target = closes_request_after_bootstrap

        with self.assertRaises((SolverPayloadError, SolverProcessExitedError)):
            await executor.execute("unused:solver", {"payload": b"value"})

        self.assertEqual(
            {child.pid for child in multiprocessing.active_children()},
            baseline,
        )

    async def test_startup_timeout_starts_before_solver_timeout_and_reaps_child(self) -> None:
        baseline = {child.pid for child in multiprocessing.active_children()}
        executor = SpawnSolverExecutor(cancellation_grace=0.05)
        executor.CHILD_STARTUP_TIMEOUT_SECONDS = 0.1
        executor._child_target = never_starts

        with self.assertRaises(SolverExecutionStartupTimeout):
            await executor.execute("unused:solver", {}, timeout=10)

        self.assertEqual(
            {child.pid for child in multiprocessing.active_children()},
            baseline,
        )

    async def test_cancel_during_startup_reaps_only_invocation_child(self) -> None:
        baseline = {child.pid for child in multiprocessing.active_children()}
        cancellation = asyncio.Event()
        executor = SpawnSolverExecutor(cancellation_grace=0.05)
        executor._child_target = never_starts
        task = asyncio.create_task(
            executor.execute("unused:solver", {}, cancellation=cancellation)
        )
        await asyncio.sleep(0.1)
        cancellation.set()

        with self.assertRaises(SolverExecutionCancelled):
            await task

        self.assertEqual(
            {child.pid for child in multiprocessing.active_children()},
            baseline,
        )

    @unittest.skipUnless(sys.platform == "win32", "Windows spawn implementation test")
    async def test_late_process_start_is_reaped_by_followup_cleanup(self) -> None:
        from multiprocessing import popen_spawn_win32

        baseline = {child.pid for child in multiprocessing.active_children()}
        original_init = popen_spawn_win32.Popen.__init__

        def slow_init(instance: object, *args: object, **kwargs: object) -> None:
            time.sleep(0.2)
            original_init(instance, *args, **kwargs)

        popen_spawn_win32.Popen.__init__ = slow_init
        executor = SpawnSolverExecutor(cancellation_grace=0.05)
        executor.CHILD_STARTUP_TIMEOUT_SECONDS = 0.05
        try:
            with self.assertRaises(SolverExecutionStartupTimeout):
                await executor.execute(f"{_FIXTURES}:payload_size", {"payload": b"x"})
            for _ in range(100):
                if not executor._late_cleanup_tasks:
                    break
                await asyncio.sleep(0.01)
        finally:
            popen_spawn_win32.Popen.__init__ = original_init

        self.assertFalse(executor._late_cleanup_tasks)
        self.assertEqual(
            {child.pid for child in multiprocessing.active_children()},
            baseline,
        )


if __name__ == "__main__":
    unittest.main()
