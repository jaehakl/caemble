"""Protocol-2 scheduling tests use fake launchers and a disposable local database."""
import os
import unittest
import uuid
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException
from sqlalchemy import select

import test_cae_batches as batch_tests
from test_cae_batches import available
from cae.batches import cancel_batch, create_batch, retry_batch
from gpstation.db import ExecutionAttempt, Job, JobBatch, JobEvent, Launcher
from gpstation.service.batches import finish_job
from gpstation.service.execution import execution_identity, resource_fits, sync_attempt
from gpstation.service.job_orchestrator import JobOrchestrator
from gpstation.service.job_service import JobService
from gpstation.service.launcher_connection import handle_launcher_message, run_launcher_control
from gpstation.service.state import RuntimeRegistry, runtime, utcnow
from gpstation.service.worker_connection import worker_assignment, worker_cleaned
from sdk.protocol.messages import JobCleaned, JobRejected, JobReserved, LauncherHello
from sdk.protocol.execution import ResourceRequest


class ResourceSelectionTests(unittest.TestCase):
    def test_pressure_and_cpu_gpu_conditions_wait_without_guessing_memory_limits(self):
        report = available({"launcher"})["launcher"]["resources"]
        self.assertTrue(resource_fits({"cpu_cores": 4}, report, "cae"))
        self.assertFalse(resource_fits({"cpu_cores": 13}, report, "cae"))
        self.assertFalse(resource_fits({"gpu_count": 1}, report, "cae"))
        self.assertFalse(resource_fits({}, {**report, "admission_open": False}, "cae"))
        self.assertFalse(resource_fits({}, {**report, "ram_used_bytes": report["ram_budget_bytes"]}, "cae"))


class SessionFencingTests(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_launcher_receives_explicit_upgrade_error(self):
        websocket = AsyncMock()
        websocket.headers = {}
        websocket.client = None
        websocket.receive_json.return_value = {"type": "launcher.hello", "launcher_name": "legacy"}
        principal = SimpleNamespace(user_id="owner", access_key_id="key", require_scope=MagicMock())
        session = AsyncMock()
        factory = MagicMock()
        factory.return_value.__aenter__.return_value = session
        with patch("gpstation.service.launcher_connection.SessionLocal", factory), \
             patch("gpstation.service.launcher_connection.authenticate_db_authorization", AsyncMock(return_value=principal)), \
             patch("gpstation.service.launcher_connection.add_auth_audit"):
            await run_launcher_control(websocket)
        websocket.close.assert_awaited_once_with(code=1008)
        self.assertEqual(websocket.send_json.call_args.args[0], {"type": "error",
            "detail": "Execution protocol 2 required; upgrade API, launcher, slave and SDK together"})

    async def test_old_control_finalizer_cannot_suspend_new_connection(self):
        registry = RuntimeRegistry()
        await registry.register_launcher("launcher", AsyncMock(), "key", boot_id="boot", session_id="old")
        await registry.register_launcher("launcher", AsyncMock(), "key", boot_id="boot", session_id="new")
        self.assertFalse(await registry.suspend_launcher("launcher", "old"))
        self.assertTrue(await registry.session_matches("launcher", "new"))
        await registry.remove_launcher("launcher", "old")
        self.assertTrue(await registry.session_matches("launcher", "new"))


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class ExecutionResourceDatabaseTests(unittest.IsolatedAsyncioTestCase):
    setUpClass = classmethod(batch_tests.CaeBatchDatabaseTests.setUpClass.__func__)
    tearDownClass = classmethod(batch_tests.CaeBatchDatabaseTests.tearDownClass.__func__)
    item = batch_tests.CaeBatchDatabaseTests.item
    create = batch_tests.CaeBatchDatabaseTests.create
    ready_job = batch_tests.CaeBatchDatabaseTests.ready_job

    async def asyncSetUp(self):
        await batch_tests.CaeBatchDatabaseTests.asyncSetUp(self)
        self.orchestrator = JobOrchestrator()
        self.launcher_ids = []

    async def asyncTearDown(self):
        for launcher_id in self.launcher_ids:
            await runtime.remove_launcher(launcher_id)
        await batch_tests.CaeBatchDatabaseTests.asyncTearDown(self)

    async def launcher(self):
        now = utcnow()
        async with self.sessions() as db:
            launcher = Launcher(user_id=self.owner_id, launcher_name="parallel", status="ready",
                slave_app_ids=["cae"], job_modes={"cae": "websocket"}, boot_id="boot", session_id="session",
                connected_at=now, last_heartbeat_at=now)
            db.add(launcher)
            await db.commit()
        self.launcher_ids.append(launcher.id)
        connection = await runtime.register_launcher(launcher.id, AsyncMock(), "key", boot_id="boot",
            session_id="session", resources=available({launcher.id})[launcher.id]["resources"])
        connection.recovering = False
        return launcher, connection

    async def test_two_jobs_one_launcher_and_cleanup_isolates_sibling(self):
        batch, _ = await self.create(count=3)
        for index in range(1, 4):
            await self.ready_job(batch.id, index=index)
        launcher, connection = await self.launcher()
        starts = []
        with patch("gpstation.service.job_orchestrator.SessionLocal", self.sessions):
            for _ in range(2):
                self.assertEqual(await self.orchestrator.dispatch_available_jobs(), 1)
                offer = connection.websocket.send_json.call_args.args[0]
                self.assertEqual(offer["type"], "job.reserve")
                allocation = {"cpu_ids": list(range(len(starts) * 4, len(starts) * 4 + 4)), "cpu_cores": 4,
                    "startup_ram_bytes": 1024**2, "ram_available_bytes": 1024**3, "gpu_devices": [], "gpu_memory_bytes": 0}
                message = JobReserved.model_validate({**offer, "type": "job.reserved", "allocation": allocation})
                async with self.sessions() as db:
                    await self.orchestrator.handle_launcher_job_event(db, launcher_id=launcher.id,
                        user_id=self.owner_id, message=message)
                starts.append(connection.websocket.send_json.call_args.args[0])
            self.assertEqual({item["type"] for item in starts}, {"job.start"})
            self.assertEqual(len({item["instance_id"] for item in starts}), 2)
            # A repeated reserve ACK yields the same token and never a new identity.
            async with self.sessions() as db:
                await self.orchestrator.handle_launcher_job_event(db, launcher_id=launcher.id,
                    user_id=self.owner_id, message=message)
            repeated = connection.websocket.send_json.call_args.args[0]
            self.assertEqual(repeated["token"], starts[-1]["token"])
            connection.resources = {**connection.resources, "admission_open": False}
            self.assertEqual(await self.orchestrator.dispatch_available_jobs(), 0)
            async with self.sessions() as db:
                first = await db.get(Job, starts[0]["job_id"])
                sibling = await db.get(Job, starts[1]["job_id"])
                _, cancellations = await cancel_batch(db, batch.id, self.owner_id, [first.id])
                self.assertEqual(cancellations, [execution_identity(first)])
                self.assertIsNone(first.cleaned_at)
                with self.assertRaises(HTTPException):
                    await retry_batch(db, batch.id, self.owner_id, [first.id])
                await db.rollback()
                self.assertTrue(await worker_cleaned(db, identity=starts[0], user_id=self.owner_id))
                sibling = await db.get(Job, starts[1]["job_id"])
                self.assertEqual(sibling.state, "assigned")
                self.assertTrue(await runtime.launcher_matches_job(launcher.id, sibling.id))
                await retry_batch(db, batch.id, self.owner_id, [starts[0]["job_id"]])
                retried = await db.get(Job, starts[0]["job_id"])
                self.assertEqual(retried.attempt_count, 2)
                self.assertNotEqual(retried.attempt_id, starts[0]["attempt_id"])
                self.assertEqual(cancellations[0]["attempt_id"], starts[0]["attempt_id"])
                previous_event = await db.scalar(select(JobEvent).where(JobEvent.job_id == retried.id,
                    JobEvent.type == "job.cancelled"))
                self.assertEqual(previous_event.payload["attempt_id"], starts[0]["attempt_id"])
                self.assertEqual(previous_event.payload["instance_id"], starts[0]["instance_id"])
                cleanup_event = await db.scalar(select(JobEvent).where(JobEvent.job_id == retried.id,
                    JobEvent.type == "job.cleaned"))
                self.assertEqual(cleanup_event.payload["reservation_id"], starts[0]["reservation_id"])
                self.assertTrue(await worker_cleaned(db, identity=starts[0], user_id=self.owner_id))
                self.assertEqual(retried.state, "queued")
                self.assertEqual((await db.get(JobBatch, batch.id)).cancelled, 0)

    async def test_refusal_requeues_same_attempt_and_waits_for_new_resource_revision(self):
        batch, _ = await self.create()
        original = await self.ready_job(batch.id)
        launcher, connection = await self.launcher()
        with patch("gpstation.service.job_orchestrator.SessionLocal", self.sessions):
            await self.orchestrator.dispatch_available_jobs()
            offer = connection.websocket.send_json.call_args.args[0]
            message = JobRejected.model_validate({**offer, "type": "job.rejected", "reason": "RAM pressure", "resource_revision": 1})
            async with self.sessions() as db:
                await self.orchestrator.handle_launcher_job_event(db, launcher_id=launcher.id, user_id=self.owner_id, message=message)
                current = await db.get(Job, original.id)
                self.assertEqual((current.state, current.attempt_count, current.attempt_id), ("queued", 1, original.attempt_id))
                self.assertEqual((await db.get(JobBatch, batch.id)).failed, 0)
            self.assertEqual(await self.orchestrator.dispatch_available_jobs(), 0)
            connection.resources = {**connection.resources, "revision": 2}
            self.assertEqual(await self.orchestrator.dispatch_available_jobs(), 1)
            next_offer = connection.websocket.send_json.call_args.args[0]
            self.assertNotEqual(next_offer["reservation_id"], offer["reservation_id"])
            self.assertEqual(next_offer["attempt_id"], offer["attempt_id"])
            async with self.sessions() as db:
                await self.orchestrator.handle_launcher_job_event(db, launcher_id=launcher.id, user_id=self.owner_id, message=message)
                self.assertEqual((await db.get(Job, original.id)).reservation_id, next_offer["reservation_id"])

    async def test_lost_reserve_ack_and_start_retry_on_same_control_connection(self):
        batch, _ = await self.create()
        await self.ready_job(batch.id)
        launcher, connection = await self.launcher()
        with patch("gpstation.service.job_orchestrator.SessionLocal", self.sessions), \
             patch("gpstation.service.launcher_connection.job_orchestrator", self.orchestrator):
            await self.orchestrator.dispatch_available_jobs()
            offer = connection.websocket.send_json.call_args.args[0]
            allocation = {"cpu_ids": [0, 1, 2, 3], "cpu_cores": 4, "startup_ram_bytes": 1024**2,
                "ram_available_bytes": 1024**3, "gpu_devices": [], "gpu_memory_bytes": 0}
            heartbeat = {"type": "launcher.heartbeat", "boot_id": "boot", "session_id": "session",
                "status": "ready", "resources": connection.resources,
                "instances": [{**offer, "status": "reserved", "allocation": allocation}]}
            connection.last_command_at[offer["reservation_id"]] = 0
            async with self.sessions() as db:
                await handle_launcher_message(db, launcher.id, self.owner_id, heartbeat)
                self.assertEqual(connection.websocket.send_json.call_args.args[0], offer)
                sends = connection.websocket.send_json.await_count
                await handle_launcher_message(db, launcher.id, self.owner_id, heartbeat)
                self.assertEqual(connection.websocket.send_json.await_count, sends)
                await self.orchestrator.handle_launcher_job_event(db, launcher_id=launcher.id,
                    user_id=self.owner_id, message=JobReserved.model_validate(
                        {**offer, "type": "job.reserved", "allocation": allocation}))
                start = connection.websocket.send_json.call_args.args[0]
                self.assertEqual(start["type"], "job.start")
                connection.last_command_at[offer["reservation_id"]] = 0
                await handle_launcher_message(db, launcher.id, self.owner_id, heartbeat)
                self.assertEqual(connection.websocket.send_json.call_args.args[0], start)
                job = await db.get(Job, offer["job_id"])
                self.assertEqual(execution_identity(job), {key: offer[key] for key in execution_identity(job)})
                self.assertEqual((job.state, job.execution_phase, job.attempt_count), ("assigned", "start_authorized", 1))
                self.assertIsNone(job.cleaned_at)
                self.assertEqual((await db.get(JobBatch, batch.id)).failed, 0)

    async def test_old_session_reply_cannot_change_job_after_durable_session_replacement(self):
        batch, _ = await self.create()
        await self.ready_job(batch.id)
        launcher, connection = await self.launcher()
        with patch("gpstation.service.job_orchestrator.SessionLocal", self.sessions):
            await self.orchestrator.dispatch_available_jobs()
        offer = connection.websocket.send_json.call_args.args[0]
        async with self.sessions() as db:
            row = await db.get(Launcher, launcher.id)
            row.session_id = "next-session"
            await db.commit()
            # The DB replacement precedes installing the new runtime connection.
            await self.orchestrator.handle_launcher_job_event(db, launcher_id=launcher.id,
                user_id=self.owner_id, message=JobRejected.model_validate(
                    {**offer, "type": "job.rejected", "reason": "no CPU", "resource_revision": 1}))
            job = await db.get(Job, offer["job_id"])
            self.assertEqual((job.state, job.reservation_id), ("assigned", offer["reservation_id"]))

    async def test_control_grace_retains_reservation_and_expiry_does_not_forge_cleanup(self):
        batch, _ = await self.create()
        await self.ready_job(batch.id)
        launcher, connection = await self.launcher()
        with patch("gpstation.service.job_orchestrator.SessionLocal", self.sessions):
            await self.orchestrator.dispatch_available_jobs()
        offer = connection.websocket.send_json.call_args.args[0]
        async with self.sessions() as db:
            await self.orchestrator.launcher_disconnected(db, launcher_id=launcher.id, session_id="session")
            await self.orchestrator.launcher_disconnected(db, launcher_id=launcher.id, session_id="session")
            job = await db.get(Job, offer["job_id"])
            self.assertEqual(job.state, "assigned")
            self.assertEqual(job.waiting_reason, "recovering")
            events = list((await db.scalars(select(JobEvent).where(JobEvent.job_id == job.id,
                JobEvent.type == "job.recovering"))).all())
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].payload["attempt_id"], job.attempt_id)
            self.assertIsNone(job.cleaned_at)
            self.assertTrue(await runtime.launcher_matches_job(launcher.id, job.id))
            row = await db.get(Launcher, launcher.id)
            row.reconnect_deadline = utcnow() - timedelta(seconds=1)
            await db.commit()
            await self.orchestrator._expire_reconnect_grace(db)
            await db.refresh(job)
            self.assertEqual(job.state, "failed")
            self.assertIsNone(job.cleaned_at)
            self.assertEqual(job.cleanup_state, "cleaning")
            with self.assertRaises(HTTPException):
                await retry_batch(db, batch.id, self.owner_id, [job.id])

    async def test_same_boot_reconnect_preserves_job_and_replays_terminal_before_cleanup(self):
        batch, _ = await self.create()
        await self.ready_job(batch.id)
        launcher, connection = await self.launcher()
        async with self.sessions() as db:
            job, _ = await JobService.claim_next_compatible_job(db, available_launchers=available({launcher.id}))
            job.boot_id = "boot"
            job.job_mode = "webrtc"
            job.state = job.execution_phase = "running"
            await sync_attempt(db, job)
            await db.commit()
            identity = execution_identity(job)
            await runtime.mark_instance(launcher.id, {**identity, "status": "running"})
            await self.orchestrator.launcher_disconnected(db, launcher_id=launcher.id, session_id="session")
            replacement = await runtime.register_launcher(launcher.id, AsyncMock(), "key", boot_id="boot", session_id="resumed",
                instances=[{**identity, "status": "running"}], resources=connection.resources)
            row = await db.get(Launcher, launcher.id)
            row.session_id, row.status, row.reconnect_deadline = "resumed", "ready", None
            await db.commit()
            hello = LauncherHello(type="launcher.hello", execution_protocol=2, installation_id="installation",
                boot_id="boot", session_id="resumed", launcher_name="parallel",
                instances=[{**identity, "status": "running"}], resources=connection.resources)
            await self.orchestrator.reconcile_launcher(db, launcher_id=launcher.id, user_id=self.owner_id, hello=hello)
            await db.refresh(job)
            self.assertEqual((job.state, job.reservation_id), ("running", identity["reservation_id"]))
            self.assertIsNone(job.cleaned_at)
            self.assertIsNone(job.waiting_reason)
            event = await db.scalar(select(JobEvent).where(JobEvent.job_id == job.id, JobEvent.type == "job.resumed"))
            self.assertEqual(event.payload["attempt_id"], identity["attempt_id"])
            self.assertFalse(replacement.recovering)
            receipt = {**identity, "type": "job.cleaned", "terminal": {**identity, "type": "job.result"}}
            hello = hello.model_copy(update={"instances": [], "cleanup_receipts": [receipt]})
            await self.orchestrator.reconcile_launcher(db, launcher_id=launcher.id, user_id=self.owner_id, hello=hello)
            await db.refresh(job)
            self.assertEqual((job.state, job.cleanup_state), ("succeeded", "cleaned"))
            self.assertIsNotNone(job.cleaned_at)
            self.assertEqual((await db.get(JobBatch, batch.id)).succeeded, 1)
            self.assertEqual(replacement.websocket.send_json.call_args.args[0]["type"], "job.cleaned.ack")
            await self.orchestrator.reconcile_launcher(db, launcher_id=launcher.id, user_id=self.owner_id, hello=hello)
            self.assertEqual((await db.get(JobBatch, batch.id)).succeeded, 1)

    async def test_batch_resources_are_frozen_separately_and_part_of_idempotency(self):
        _, request = await self.create()
        request = request.model_copy(update={"request_id": uuid.uuid4(), "resources": ResourceRequest(cpu_cores=2)})
        async with self.sessions() as db:
            batch = await create_batch(db, request, self.owner, self.catalog)
            job = await db.scalar(select(Job).where(Job.batch_id == batch.id))
            self.assertEqual(job.resources, {"cpu_cores": 2})
            self.assertIsNone(job.input)
            self.assertEqual(job.state, "staged")
            repeated = await create_batch(db, request, self.owner, self.catalog)
            self.assertEqual(repeated.id, batch.id)
            changed = request.model_copy(update={"resources": ResourceRequest(cpu_cores=3)})
            with self.assertRaises(HTTPException) as conflict:
                await create_batch(db, changed, self.owner, self.catalog)
            self.assertEqual(conflict.exception.status_code, 409)
