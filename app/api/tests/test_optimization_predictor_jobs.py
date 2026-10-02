"""Real DB checks for parent-scoped Predictor admission, fencing and cleanup."""
import asyncio
import hashlib
import os
import socket
import unittest
from datetime import timedelta
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import delete, select
from fastapi import FastAPI, WebSocket
import uvicorn
import websockets

import test_prediction_assets as fixtures
from gpstation.db import Job, JobBatch, Launcher
from gpstation.models import JobCreateRequest
from sdk.protocol.execution import ResourceRequest
from gpstation.service.state import utcnow
from gpstation.service import worker_connection
from gpstation.service.execution import execution_identity
from gpstation.service.server_handlers import server_handlers
from optimization import predictor_jobs
from optimization import evaluation
from optimization.db import Optimization, StageSubmission, Trial
from optimization.guards import require_unmanaged_execution, unmanaged_execution_clause
from prediction.db import Dataset, ModelLease, ModelRevision, PredictionModel, Replica
from storage.db import StorageObject
from storage.service import cleanup_objects


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class PredictorChildJobTests(unittest.IsolatedAsyncioTestCase):
    setUpClass = classmethod(fixtures.PredictionAssetsTests.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.PredictionAssetsTests.tearDownClass.__func__)
    asyncSetUp = fixtures.PredictionAssetsTests.asyncSetUp
    asyncTearDown = fixtures.PredictionAssetsTests.asyncTearDown

    async def seed(self):
        self.parent_id, self.attempt_id, self.model_id, self.replica_id = (str(uuid4()) for _ in range(4))
        self.authorization = "Bearer parent-worker-token"
        self.model_definition = {"algorithm": {"kind": "knn"}, "implementationVersion": "knn-v1", "preprocessingVersion": "box-relative-v2"}
        self.resources = {"evaluation": {"cpu_cores": 1, "startup_ram_bytes": 100, "gpu_count": 0, "gpu_memory_bytes": 0},
                          "predictor": {"cpu_cores": 1, "startup_ram_bytes": 200, "gpu_count": 0, "gpu_memory_bytes": 0}}
        self.body = JobCreateRequest(handler_type="predictor.hello", slave_app_id="predictor", offer={"type": "offer", "sdp": "fixture"})
        async with self.sessions() as db:
            launcher = await db.get(Launcher, self.launcher_id)
            launcher.slave_app_ids = ["evaluation", "predictor"]
            launcher.job_modes = {"evaluation": "websocket", "predictor": "webrtc"}
            launcher.resources = {"cpu_total": 2, "cpu_reserved": 0, "ram_budget_bytes": 1000,
                "defaults": {"evaluation": {"startup_ram_bytes": 100}, "predictor": {"startup_ram_bytes": 200}}}
            dataset = Dataset(id=str(uuid4()), user_id=self.owner, experiment_id=self.experiment_id, name="fixture", selection={}, current_revision=1)
            model = PredictionModel(id=self.model_id, user_id=self.owner, experiment_id=self.experiment_id, name="fixture", direction="forward", current_revision=1)
            db.add_all([dataset, model])
            await db.flush()
            db.add(ModelRevision(model_id=model.id, revision=1, request_id=str(uuid4()), request_hash="h", state="ready",
                dataset_id=dataset.id, dataset_revision=1, dataset_fingerprint="f", definition=self.model_definition, source_contracts={}, artifact={"manifest_sha256": "a" * 64}))
            await db.flush()
            db.add(Replica(id=self.replica_id, model_id=model.id, revision=1, storage_id=self.storage_id,
                state="present", manifest_sha256="a" * 64))
            self.optimization_id = str(uuid4())
            db.add(Optimization(id=self.optimization_id, user_id=self.owner, experiment_id=self.experiment_id,
                name="Hybrid fixture", request_id=str(uuid4()), request_hash="fixture", definition={}, settings={}))
            db.add(Job(id=self.parent_id, user_id=self.owner, launcher_id=self.launcher_id, target_launcher_id=self.launcher_id,
                slave_app_id="evaluation", handler_type="cae.evaluation.predict", job_mode="websocket", state="running",
                offer={}, progress=[], attempt_id=self.attempt_id, attempt_count=1,
                artifact_metadata={"optimization_id": self.optimization_id},
                worker_token_hash=hashlib.sha256(b"parent-worker-token").hexdigest(), input={"stage": "predict", "hybrid": {
                    "model_id": model.id, "revision": 1, "checksum": "a" * 64, "replica_id": self.replica_id,
                    "storage_id": self.storage_id, "launcher_id": self.launcher_id, "resources": self.resources}}))
            await db.commit()

    async def create(self, db):
        return await predictor_jobs.create_child(self.parent_id, self.attempt_id, self.body, self.authorization, db)

    async def test_create_is_atomic_idempotent_and_attempt_scoped(self):
        await self.seed()
        async with self.sessions() as db:
            first = await self.create(db)
            second = await self.create(db)
            self.assertEqual(first["job"].id, second["job"].id)
            child = await db.get(Job, first["job"].id)
            self.assertEqual(child.resources, {"cpu_cores": 1, "startup_ram_bytes": 200, "gpu_count": 0, "gpu_memory_bytes": 0})
            lease = await db.get(ModelLease, (self.model_id, 1, child.id))
            self.assertEqual(lease.replica_id, self.replica_id)
            db.expire(child, ["artifact_metadata"])
            parent = await db.get(Job, self.parent_id)
            self.assertEqual((await predictor_jobs.owned_child(db, parent, child.id)).id, child.id)
            with self.assertRaises(HTTPException) as managed:
                await require_unmanaged_execution(db, job_id=child.id, user_id=self.owner)
            self.assertEqual(managed.exception.detail["optimization_id"], self.optimization_id)
            self.assertIsNone(await db.scalar(select(Job.id).where(Job.id == child.id, unmanaged_execution_clause())))
            for attempt, token in ((str(uuid4()), self.authorization), (self.attempt_id, "Bearer account-token")):
                with self.assertRaises(HTTPException) as denied:
                    await predictor_jobs.create_child(self.parent_id, attempt, self.body, token, db)
                self.assertEqual(denied.exception.status_code, 403)
            self.body.offer = {"type": "offer", "sdp": "another-session"}
            with self.assertRaises(HTTPException) as duplicate:
                await self.create(db)
            self.assertEqual(duplicate.exception.status_code, 409)

    async def test_changed_copy_rejected_and_capacity_checks_both_processes(self):
        await self.seed()
        async with self.sessions() as db:
            replica = await db.get(Replica, self.replica_id)
            replica.manifest_sha256 = "b" * 64
            await db.commit()
            with self.assertRaises(HTTPException) as denied:
                await self.create(db)
            self.assertEqual(denied.exception.status_code, 409)
            self.assertIsNone(await db.scalar(select(ModelLease).where(ModelLease.model_id == self.model_id)))
            launcher = await db.get(Launcher, self.launcher_id)
            original = launcher.resources
            for change in ({"cpu_total": 1}, {"ram_budget_bytes": 250}):
                launcher.resources = {**original, **change}
                with self.assertRaises(HTTPException) as capacity:
                    await predictor_jobs.validate_hybrid_capacity(db, self.launcher_id, self.owner, self.model_definition)
                self.assertEqual(capacity.exception.status_code, 422)

    async def test_child_uses_frozen_profile_after_defaults_or_client_request_change(self):
        await self.seed()
        async with self.sessions() as db:
            pinned = {"cpu_cores": 3, "startup_ram_bytes": 500, "gpu_count": 1, "gpu_memory_bytes": 400}
            parent = await db.get(Job, self.parent_id)
            parent.input = {**parent.input, "hybrid": {**parent.input["hybrid"],
                "resources": {**self.resources, "predictor": pinned}}}
            launcher = await db.get(Launcher, self.launcher_id)
            launcher.resources = {**launcher.resources, "defaults": {"predictor": {"cpu_cores": 8, "gpu_count": 0}}}
            await db.commit()
            body = self.body.model_copy(update={"resources": ResourceRequest(cpu_cores=1, gpu_count=0)})
            response = await predictor_jobs.create_child(self.parent_id, self.attempt_id, body, self.authorization, db)
            child = await db.get(Job, response["job"].id)
            self.assertEqual(child.resources, pinned)

    async def test_parent_end_cancels_child_but_lease_waits_for_process_cleanup(self):
        await self.seed()
        async with self.sessions() as db:
            response = await self.create(db)
            child = await db.get(Job, response["job"].id)
            child.launcher_id, child.state = self.launcher_id, "running"
            parent = await db.get(Job, self.parent_id)
            parent.state, parent.cleaned_at = "failed", utcnow()
            await db.commit()
            await predictor_jobs.reconcile_children(db)
            self.assertIsNotNone(child.cancel_requested_at)
            self.assertIsNotNone(await db.get(ModelLease, (self.model_id, 1, child.id)))
            self.assertFalse(await predictor_jobs.predictor_parent_available(db, self.launcher_id, self.resources))
            child.state, child.cleaned_at = "killed", utcnow()
            await db.commit()
            await predictor_jobs.reconcile_children(db)
            self.assertIsNone(await db.get(ModelLease, (self.model_id, 1, child.id)))
            self.assertTrue(await predictor_jobs.predictor_parent_available(db, self.launcher_id, self.resources))

    async def test_queued_child_cancel_releases_lease_without_a_process_receipt(self):
        await self.seed()
        async with self.sessions() as db:
            response = await self.create(db)
            parent = await db.get(Job, self.parent_id)
            parent.state, parent.cleaned_at = "cancelled", utcnow()
            await db.commit()
            await predictor_jobs.reconcile_children(db)
            child = await db.get(Job, response["job"].id)
            self.assertEqual(child.state, "killed")
            self.assertIsNone(await db.get(ModelLease, (self.model_id, 1, child.id)))
            self.assertTrue(await predictor_jobs.predictor_parent_available(db, self.launcher_id, self.resources))

    async def test_resource_wait_code_crosses_worker_transport_before_terminal_commit(self):
        await self.seed()
        async with self.sessions() as db:
            parent = await db.get(Job, self.parent_id)
            parent.state, parent.boot_id = "assigned", "boot"
            parent.execution_phase = "start_authorized"
            parent.instance_id, parent.reservation_id = str(uuid4()), str(uuid4())
            await db.commit()
            assignment = await worker_connection.worker_assignment(db, parent)
            identity = execution_identity(parent)
        app = FastAPI()

        @app.websocket("/jobs/{job_id}")
        async def stream(socket: WebSocket, job_id: str):
            await worker_connection.run_worker_connection(socket, job_id)

        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
        with patch.object(worker_connection, "SessionLocal", self.sessions), \
                patch.object(worker_connection.runtime, "launcher_matches_job", AsyncMock(return_value=True)), \
                patch.dict(server_handlers, {"cae.evaluation.predict": evaluation}):
            server_task = asyncio.create_task(server.serve(sockets=[listener]))
            try:
                while not server.started:
                    await asyncio.sleep(.01)
                from sdk.protocol.packets import receive_packet, send_packet
                async with websockets.connect(f"ws://127.0.0.1:{listener.getsockname()[1]}/jobs/{self.parent_id}",
                    additional_headers={"Authorization": "Bearer " + assignment["token"]}) as connection:
                    await send_packet(connection.send, connection.send, {"type": "job.ready", **identity})
                    payload, _ = await receive_packet(connection.recv)
                    self.assertEqual(payload["type"], "job.input", payload)
                    await send_packet(connection.send, connection.send, {"type": "job.failed", **identity,
                        "code": "prediction-resource-wait", "detail": "Predictor connection exceeded 30 seconds."})
                    response, _ = await receive_packet(connection.recv)
                    self.assertEqual(response["type"], "job.complete.ack")
                async with self.sessions() as db:
                    parent = await db.get(Job, self.parent_id)
                    self.assertEqual(parent.state, "failed")
                    self.assertTrue(parent.artifact_metadata["optimization_resource_wait"])
            finally:
                server.should_exit = True
                await server_task
                listener.close()

    async def test_prediction_artifact_retained_until_optimization_history_is_deleted(self):
        await self.seed()
        async with self.sessions() as db:
            trial = Trial(optimization_id=self.optimization_id, ordinal=1, variables={}, fingerprint="fixture")
            batch = JobBatch(user_id=self.owner, request_id=str(uuid4()), request_hash="fixture", total=1,
                state="completed", created_count=1, succeeded=1, failed=0, cancelled=0)
            db.add_all([trial, batch])
            await db.flush()
            parent = await db.get(Job, self.parent_id)
            parent.batch_id = batch.id
            db.add(StageSubmission(trial_id=trial.id, stage="predict", generation=1,
                batch_id=batch.id, job_id=parent.id, state="succeeded"))
            source_object = await db.get(StorageObject, self.object_id)
            artifact = StorageObject(id=str(uuid4()), user_id=self.owner, experiment_id=self.experiment_id,
                purpose="evaluation", job_id=parent.id, attempt=1, ready=True, bound=True,
                manifest=source_object.manifest, updated_at=utcnow() - timedelta(hours=25))
            db.add(artifact)
            await db.commit()
            await cleanup_objects(db)
            self.assertFalse(artifact.deleting)
            artifact.updated_at = utcnow() - timedelta(hours=25)
            await db.execute(delete(Optimization).where(Optimization.id == self.optimization_id))
            await db.commit()
            await cleanup_objects(db)
            self.assertTrue(artifact.deleting)
            self.assertIsNotNone(await db.get(StorageObject, artifact.id))
