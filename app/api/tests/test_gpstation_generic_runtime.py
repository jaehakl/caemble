"""A fake Launcher completes generic jobs without application handlers."""

import asyncio
import os
import sys
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.engine import make_url

from db import make_async_db_url
from gpstation.db import ExecutionAttempt, Job, Launcher
from gpstation.service.batches import finish_job
from gpstation.service.execution import IDENTITY_FIELDS
from gpstation.service.job_orchestrator import JobOrchestrator
from gpstation.service.server_handlers import server_handlers
from gpstation.service.state import runtime, utcnow
from model_registry import register_models
from sdk.protocol.messages import parse_launcher_message
from user_auth.db import User
from test_calculation_database import _create_database, _database_url, _drop_database, _upgrade


class GenericTerminalCallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_unbatched_or_missing_batch_still_finishes_in_callers_session(self):
        register_models()
        for batch_id in (None, "missing-batch"):
            with self.subTest(batch_id=batch_id):
                db = AsyncMock()
                db.scalar.return_value = None
                callback = AsyncMock()
                handler = SimpleNamespace(on_finished=callback)
                job = SimpleNamespace(id="job", state="running", reservation_id="reservation",
                    cleaned_at=None, attempt_id=None, attempt_count=1, batch_id=batch_id,
                    handler_type="example.echo")
                with patch.dict(server_handlers, {"example.echo": handler}, clear=True):
                    self.assertTrue(await finish_job(db, job, "succeeded", result={"value": 7}))
                    self.assertFalse(await finish_job(db, job, "succeeded", result={"value": 7}))
                callback.assert_awaited_once_with(db, job, {"value": 7})
                self.assertEqual((job.state, job.cleanup_state), ("succeeded", "cleaning"))
                db.commit.assert_not_awaited()
                db.rollback.assert_not_awaited()
                if batch_id is None:
                    db.scalar.assert_not_awaited()


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class GenericRuntimeTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        register_models()
        cls.database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        if make_url(_database_url(cls.database)).host not in {"localhost", "127.0.0.1", "::1"}:
            raise RuntimeError("Generic runtime tests require a loopback PostgreSQL URL.")
        asyncio.run(_create_database(cls.database))
        try:
            _upgrade(cls.database, "head")
        except BaseException:
            asyncio.run(_drop_database(cls.database))
            raise

    @classmethod
    def tearDownClass(cls):
        asyncio.run(_drop_database(cls.database))

    async def test_success_cancel_and_cleanup_without_product_handlers(self):
        engine = create_async_engine(make_async_db_url(_database_url(self.database)))
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        launcher_id = str(uuid.uuid4())
        owner_id = str(uuid.uuid4())
        orchestrator = JobOrchestrator()
        websocket = AsyncMock()
        resources = {
            "revision": 1, "admission_open": True, "cpu_total": 2, "cpu_reserved": 0,
            "ram_budget_bytes": 4096, "ram_used_bytes": 0, "ram_startup_reserved_bytes": 0,
            "gpu_devices": [], "defaults": {"cpu_cores": 1, "startup_ram_bytes": 1024, "gpu_count": 0},
        }
        try:
            async with sessions() as db:
                db.add(User(id=owner_id, is_active=True))
                db.add(Launcher(id=launcher_id, user_id=owner_id, launcher_name="generic fixture",
                    status="ready", slave_app_ids=["example"], job_modes={"example": "webrtc"},
                    boot_id="boot", session_id="session", connected_at=utcnow(), last_heartbeat_at=utcnow()))
                await db.commit()
            connection = await runtime.register_launcher(launcher_id, websocket, "key",
                boot_id="boot", session_id="session", resources=resources)
            connection.recovering = False
            with patch.dict(server_handlers, {}, clear=True), \
                 patch("gpstation.service.job_orchestrator.SessionLocal", sessions):
                for cancel in (False, True):
                    with self.subTest(cancel=cancel):
                        async with sessions() as db:
                            job = await orchestrator.create_job(db, user_id=owner_id, handler_type="example.echo",
                                slave_app_id="example", offer={"type": "offer", "sdp": "generic-offer"},
                                resources={"cpu_cores": 1, "startup_ram_bytes": 1024, "gpu_count": 0})
                        self.assertEqual(await orchestrator.dispatch_available_jobs(), 1)
                        reserve = websocket.send_json.call_args.args[0]
                        self.assertEqual(reserve["type"], "job.reserve")
                        identity = {key: reserve[key] for key in IDENTITY_FIELDS}
                        identity["session_id"] = "session"
                        allocation = {"cpu_ids": [0], "cpu_cores": 1, "startup_ram_bytes": 1024,
                                      "ram_available_bytes": 4096, "gpu_devices": [], "gpu_memory_bytes": 0}
                        messages = [
                            {"type": "job.reserved", "allocation": allocation},
                            {"type": "job.answer", "answer": {"type": "answer", "sdp": "generic-answer"}},
                            {"type": "job.running"},
                            {"type": "job.progress", "progress": {"done": 1}},
                        ]
                        for message in messages:
                            async with sessions() as db:
                                await orchestrator.handle_launcher_job_event(db, launcher_id=launcher_id,
                                    user_id=owner_id, message=parse_launcher_message({**identity, **message}))
                            if message["type"] == "job.reserved":
                                start = websocket.send_json.call_args.args[0]
                                self.assertEqual((start["type"], start["offer"]["sdp"]), ("job.start", "generic-offer"))
                        if cancel:
                            async with sessions() as db:
                                await orchestrator.kill_job(db, job_id=job.id, user_id=owner_id, reason="fixture cancel")
                            self.assertEqual(websocket.send_json.call_args.args[0]["type"], "job.cancel")
                        async with sessions() as db:
                            await orchestrator.handle_launcher_job_event(db, launcher_id=launcher_id,
                                user_id=owner_id, message=parse_launcher_message({**identity, "type": "job.result"}))
                            current = await db.get(Job, job.id)
                            self.assertEqual(current.state, "cancelled" if cancel else "succeeded")
                            self.assertEqual(current.progress[-1]["progress"], {"done": 1})
                            self.assertEqual(current.cleanup_state, "cleaning")
                        async with sessions() as db:
                            await orchestrator.handle_launcher_job_event(db, launcher_id=launcher_id,
                                user_id=owner_id, message=parse_launcher_message({**identity, "type": "job.cleaned"}))
                            attempt = await db.get(ExecutionAttempt, identity["attempt_id"])
                            self.assertEqual(attempt.result_state, "cancelled" if cancel else "succeeded")
                            self.assertEqual(attempt.cleanup_state, "cleaned")
                        self.assertEqual(websocket.send_json.call_args.args[0]["type"], "job.cleaned.ack")
                        self.assertFalse(await runtime.launcher_matches_job(launcher_id, job.id))
                        self.assertEqual(server_handlers, {})
        finally:
            await runtime.remove_launcher(launcher_id)
            await engine.dispose()


if __name__ == "__main__":
    unittest.main()
