"""Application composition owns domain tasks and cleans up partial startup."""
from __future__ import annotations

import asyncio
from contextlib import ExitStack
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

import bootstrap
from gpstation.service.server_handlers import server_handlers
from simulation.services import maintenance


class ApplicationLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def dependencies(self, stack: ExitStack, failure: str | None = None):
        trace: list[str] = []
        app = FastAPI()
        db = SimpleNamespace()
        session = AsyncMock()
        session.__aenter__.return_value = db
        stack.enter_context(patch.object(bootstrap, "SessionLocal", return_value=session))
        stack.enter_context(patch.object(bootstrap, "engine", SimpleNamespace(dispose=AsyncMock())))
        stack.enter_context(patch.object(bootstrap.logger, "disabled", False))
        stack.enter_context(patch.dict(server_handlers, clear=True))
        catalog = SimpleNamespace(close=Mock(side_effect=lambda: trace.append("catalog.close")))

        def open_catalog():
            trace.append("catalog.open")
            if failure == "catalog.open":
                raise RuntimeError(failure)
            return catalog

        stack.enter_context(patch.object(bootstrap.Catalog, "open_readonly", side_effect=open_catalog))
        for owner, attribute, name in (
            (bootstrap.JobService, "recover_after_server_restart", "recover"),
            (bootstrap, "fail_server_jobs", "fail-active"),
            (bootstrap, "reconcile_once", "reconcile"),
            (maintenance, "expire_once", "expire-uploads"),
            (bootstrap.job_orchestrator, "start_dispatcher", "dispatcher.start"),
            (bootstrap.job_orchestrator, "stop_dispatcher", "dispatcher.stop"),
            (bootstrap, "start_controller", "controller.start"),
            (bootstrap, "stop_controller", "controller.stop"),
            (maintenance, "start", "maintenance.start"),
            (maintenance, "stop", "maintenance.stop"),
            (bootstrap.runtime, "close_all_launchers", "launchers.close"),
            (bootstrap.engine, "dispose", "engine.dispose"),
        ):
            async def operation(*args, _name=name, **kwargs):
                trace.append(_name)
                if _name == "recover":
                    self.assertEqual(set(server_handlers), {"cae.simulation", "cae.evaluation.build", "cae.evaluation.calculate"})
                    self.assertIs(args[0], db)
                if _name == failure:
                    raise RuntimeError(_name)
            stack.enter_context(patch.object(owner, attribute, AsyncMock(side_effect=operation)))

        async def cleanup_loop():
            trace.append("cleanup.start")
            try:
                await asyncio.Event().wait()
            finally:
                trace.append("cleanup.stop")

        stack.enter_context(patch.object(bootstrap, "_cleanup_loop", cleanup_loop))
        return app, trace

    async def test_restart_recovery_precedes_dispatch_and_shutdown_reverses_ownership(self):
        with ExitStack() as stack:
            app, trace = self.dependencies(stack)
            async with bootstrap.lifespan(app):
                await asyncio.sleep(0)
                self.assertTrue(app.state.running)
                self.assertEqual(trace, [
                    "catalog.open", "recover", "fail-active", "reconcile", "expire-uploads",
                    "dispatcher.start", "controller.start", "maintenance.start", "cleanup.start",
                ])
            self.assertEqual(trace[-7:], [
                "cleanup.stop", "maintenance.stop", "controller.stop", "dispatcher.stop",
                "launchers.close", "catalog.close", "engine.dispose",
            ])
            self.assertFalse(app.state.running)
            self.assertIsNone(app.state.catalog)

    async def test_reentrant_lifespan_does_not_start_duplicate_tasks(self):
        with ExitStack() as stack:
            app, trace = self.dependencies(stack)
            async with bootstrap.lifespan(app):
                with self.assertRaisesRegex(RuntimeError, "already running"):
                    async with bootstrap.lifespan(app):
                        self.fail("A second lifespan entered")
                self.assertTrue(app.state.running)
                self.assertEqual(trace.count("dispatcher.start"), 1)
                self.assertEqual(trace.count("controller.start"), 1)
                self.assertEqual(trace.count("maintenance.start"), 1)
                await asyncio.sleep(0)

    async def test_partial_startup_closes_every_acquired_resource(self):
        cases = {
            "catalog.open": ["engine.dispose"],
            "recover": ["launchers.close", "catalog.close", "engine.dispose"],
            "reconcile": ["launchers.close", "catalog.close", "engine.dispose"],
            "dispatcher.start": ["dispatcher.stop", "launchers.close", "catalog.close", "engine.dispose"],
            "controller.start": ["controller.stop", "dispatcher.stop", "launchers.close", "catalog.close", "engine.dispose"],
            "maintenance.start": ["maintenance.stop", "controller.stop", "dispatcher.stop", "launchers.close", "catalog.close", "engine.dispose"],
        }
        for failure, shutdown in cases.items():
            with self.subTest(failure=failure), ExitStack() as stack:
                app, trace = self.dependencies(stack, failure)
                with self.assertRaisesRegex(RuntimeError, failure):
                    async with bootstrap.lifespan(app):
                        self.fail("Failed startup entered the application")
                self.assertEqual(trace[-len(shutdown):], shutdown)
                self.assertNotIn("cleanup.start", trace)
                self.assertFalse(app.state.running)
                self.assertIsNone(app.state.catalog)

    async def test_initial_expiry_failure_still_starts_periodic_maintenance(self):
        with ExitStack() as stack:
            app, trace = self.dependencies(stack, "expire-uploads")
            with self.assertLogs(bootstrap.logger, level="WARNING"):
                async with bootstrap.lifespan(app):
                    await asyncio.sleep(0)
                    self.assertTrue(app.state.running)
                    self.assertIn("dispatcher.start", trace)
                    self.assertIn("controller.start", trace)
                    self.assertIn("maintenance.start", trace)
                    self.assertIn("cleanup.start", trace)
            self.assertEqual(trace[-7:], [
                "cleanup.stop", "maintenance.stop", "controller.stop", "dispatcher.stop",
                "launchers.close", "catalog.close", "engine.dispose",
            ])

    async def test_shutdown_failure_does_not_skip_remaining_cleanup(self):
        with ExitStack() as stack:
            app, trace = self.dependencies(stack, "controller.stop")
            with self.assertRaisesRegex(RuntimeError, "controller.stop"):
                async with bootstrap.lifespan(app):
                    await asyncio.sleep(0)
            self.assertEqual(trace[-5:], ["controller.stop", "dispatcher.stop", "launchers.close", "catalog.close", "engine.dispose"])
            self.assertFalse(app.state.running)


class SimulationMaintenanceTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_is_idempotent_and_stop_awaits_the_task(self):
        async def wait_until_stopped():
            await asyncio.Event().wait()

        with patch.object(maintenance, "_task", None), patch.object(maintenance, "_run", wait_until_stopped):
            try:
                await maintenance.start()
                first = maintenance._task
                await maintenance.start()
                self.assertIs(maintenance._task, first)
            finally:
                await maintenance.stop()
            self.assertTrue(first.done())
            self.assertIsNone(maintenance._task)
            await maintenance.stop()

    async def test_failed_expiry_retries_on_the_next_tick(self):
        sleeps = AsyncMock(side_effect=[None, None, asyncio.CancelledError()])
        expires = AsyncMock(side_effect=[RuntimeError("temporary failure"), 0])
        with patch.object(maintenance.asyncio, "sleep", sleeps), patch.object(maintenance, "expire_once", expires), patch.object(maintenance.logger, "disabled", False), self.assertLogs(maintenance.logger, level="ERROR"):
            with self.assertRaises(asyncio.CancelledError):
                await maintenance._run()
        self.assertEqual(expires.await_count, 2)


if __name__ == "__main__":
    unittest.main()
