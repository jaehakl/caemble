"""Exact-copy automatic cleanup on disposable PostgreSQL, without a Solver."""
import asyncio
import hashlib
import json
import os
import unittest
from datetime import timedelta
from uuid import UUID, uuid4
from unittest.mock import patch

import asyncpg
from fastapi import HTTPException
from sqlalchemy import delete, func, select

from gpstation.db import Job, Launcher
from gpstation.service.state import utcnow
from optimization.db import Evaluation, Optimization, OptimizationModelPin, Trial
from optimization import model_maintenance
from prediction import operations, training
from prediction.datasets import freeze_dataset
from prediction.db import ModelLease, ModelRevision, Operation, PredictionModel, Replica
from prediction.models import complete_model, lease_model, reserve_model
from prediction.schemas import ModelLeaseRequest, OperationComplete
import test_prediction_assets as assets
from test_calculation_database import _check, _connect_arguments, _create_database, _drop_database, _seed_owners, _upgrade


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class OptimizationModelMaintenanceTests(unittest.IsolatedAsyncioTestCase):
    setUpClass = classmethod(assets.PredictionAssetsTests.setUpClass.__func__)
    tearDownClass = classmethod(assets.PredictionAssetsTests.tearDownClass.__func__)
    selection = assets.PredictionAssetsTests.selection
    model_request = assets.PredictionAssetsTests.model_request
    completion = assets.PredictionAssetsTests.completion

    async def asyncSetUp(self):
        await assets.PredictionAssetsTests.asyncSetUp(self)
        self.origins = [str(uuid4()), str(uuid4())]
        async with self.sessions() as db:
            launcher = await db.get(Launcher, self.launcher_id)
            launcher.slave_app_ids = ["predictor", training.APP_ID]
            launcher.job_modes = {training.APP_ID: "websocket"}
            launcher.resources = {"cpu_total": 4, "ram_budget_bytes": 2 ** 30,
                "defaults": {training.APP_ID: {"startup_ram_bytes": 2 ** 20}}}
            await db.commit()
            self.dataset = await freeze_dataset(db, self.selection(), self.owner)
            reserved = await reserve_model(db, self.model_request(self.dataset), self.owner)
            self.model_id = reserved["id"]
            await complete_model(db, self.model_id, 1, self.completion(reserved["operation_id"]), self.owner)

    async def asyncTearDown(self):
        await assets.PredictionAssetsTests.asyncTearDown(self)

    async def generated(self, db, number, origin=None):
        initial = await db.get(ModelRevision, (self.model_id, 1))
        request_id, replica_id = str(uuid4()), str(uuid4())
        origin = origin or self.origins[0]
        db.add(ModelRevision(model_id=self.model_id, revision=number, request_id=request_id,
            request_hash="generated-fixture", state="ready", dataset_id=initial.dataset_id,
            dataset_revision=initial.dataset_revision, dataset_fingerprint=initial.dataset_fingerprint,
            definition=initial.definition, source_contracts=initial.source_contracts, artifact=initial.artifact,
            preparation={"storage_id": self.storage_id, "launcher_id": self.launcher_id,
                "online_origin": {"optimization_id": origin, "optimization_name": "Origin fixture"}}))
        await db.flush()
        replica = Replica(id=replica_id, model_id=self.model_id, revision=number, storage_id=self.storage_id,
            state="present", manifest_sha256=initial.artifact["manifest_sha256"], artifact=initial.artifact)
        db.add(replica)
        db.add(Operation(id=request_id, request_id=request_id, request_hash="generated-fixture", user_id=self.owner,
            kind="prepare", asset_kind="model", asset_id=self.model_id, revision=number,
            experiment_id=self.experiment_id, state="completed", stage="completed",
            details={"result_replicas": {"model": replica_id}}))
        model = await db.get(PredictionModel, self.model_id)
        model.current_revision = max(model.current_revision, number)
        await db.commit()
        return replica

    async def pin(self, db, replica):
        optimization = Optimization(id=str(uuid4()), user_id=self.owner, experiment_id=self.experiment_id,
            name="Another Optimization", request_id=str(uuid4()), request_hash="pin-fixture", state="paused",
            definition={"hash": "preserved"}, settings={}, optimizer_state={})
        db.add(optimization)
        await db.flush()
        pin = OptimizationModelPin(optimization_id=optimization.id, slot="active", model_id=self.model_id,
            revision=replica.revision, replica_id=replica.id, storage_id=replica.storage_id)
        db.add(pin)
        await db.commit()
        return pin

    async def test_latest_per_origin_and_initial_external_copies_are_preserved(self):
        async with self.sessions() as db:
            old_a = await self.generated(db, 2)
            old_b = await self.generated(db, 3, self.origins[1])
            latest_a = await self.generated(db, 4)
            latest_b = await self.generated(db, 5, self.origins[1])
            from prediction.replicas import managed_storage
            backup_storage = await managed_storage(db, self.owner, "object_backup")
            backup = Replica(id=str(uuid4()), model_id=self.model_id, revision=2, storage_id=backup_storage.storage_id,
                state="present", manifest_sha256=old_a.manifest_sha256, artifact=old_a.artifact)
            db.add(backup)
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            await model_maintenance.reconcile_pruning(db)
            jobs = (await db.scalars(select(Job).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner))).all()
            self.assertEqual({job.input["replicaId"] for job in jobs}, {old_a.id, old_b.id})
            self.assertEqual(len(jobs), 2)
            for replica in (old_a, old_b, latest_a, latest_b):
                self.assertEqual(replica.state, "present")
            initial = await db.scalar(select(Replica).where(Replica.model_id == self.model_id, Replica.revision == 1))
            self.assertEqual(initial.state, "present")
            self.assertEqual(backup.state, "present")

    async def test_other_optimization_pin_defers_cleanup_until_released(self):
        async with self.sessions() as db:
            old = await self.generated(db, 2)
            await self.generated(db, 3)
            pin = await self.pin(db, old)
            await model_maintenance.reconcile_pruning(db)
            self.assertIsNone(await db.scalar(select(Job.id).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner)))
            await db.delete(pin)
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertEqual(await db.scalar(select(func.count()).select_from(Job).where(
                Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner)), 1)
            self.assertEqual(old.state, "present")

    async def test_base_training_pin_defers_cleanup_through_retryable_failure(self):
        async with self.sessions() as db:
            old = await self.generated(db, 2)
            await self.generated(db, 3)
            source = await db.get(ModelRevision, (self.model_id, 2))
            ref = {"datasetId": source.dataset_id, "revision": source.dataset_revision,
                "fingerprint": source.dataset_fingerprint}
            update = {"mode": "rebuild", "baseModel": {"modelId": self.model_id, "revision": 2,
                "checksum": old.manifest_sha256, "storageId": self.storage_id, "replicaId": old.id},
                "targetSnapshot": ref, "changeSet": {"baseSnapshot": ref, "targetSnapshot": ref,
                    "added": [], "changed": [], "removed": []}, "recipe": {}}
            reserved = await reserve_model(db, self.model_request(self.dataset, model_id=self.model_id,
                expected_revision=3, definition={**source.definition, "snapshotFingerprint": ref["fingerprint"]},
                training_update=update), self.owner, force_api_source=True)
            preparation = await db.get(Operation, reserved["operation_id"])
            preparation.state = "failed"
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertIsNone(await db.scalar(select(Job.id).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner)))
            await training.cancel(db, preparation)
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertIsNotNone(await db.scalar(select(Job.id).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner)))

    async def test_job_read_lease_and_backup_transfer_each_defer_cleanup(self):
        async with self.sessions() as db:
            old = await self.generated(db, 2)
            await self.generated(db, 3)
            job = Job(id=str(uuid4()), user_id=self.owner, slave_app_id="predictor", handler_type="predictor",
                job_mode="webrtc", state="running", launcher_id=self.launcher_id, progress=[])
            db.add(job)
            await db.flush()
            lease = ModelLease(model_id=self.model_id, revision=2, job_id=job.id,
                storage_id=self.storage_id, replica_id=old.id)
            db.add(lease)
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertIsNone(await db.scalar(select(Job.id).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner)))
            await db.delete(lease)
            identity = str(uuid4())
            transfer = Operation(id=identity, request_id=identity, request_hash="transfer-fixture", user_id=self.owner,
                kind="backup", asset_kind="model", asset_id=self.model_id, revision=2,
                experiment_id=self.experiment_id, state="interrupted", stage="copying", details={"source_replica_id": old.id})
            db.add(transfer)
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertIsNone(await db.scalar(select(Job.id).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner)))
            transfer.state = "cancelled"
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertIsNotNone(await db.scalar(select(Job.id).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner)))

    async def test_offline_launcher_and_admission_error_leave_readable_pending_copy(self):
        async with self.sessions() as db:
            old = await self.generated(db, 2)
            await self.generated(db, 3)
            launcher = await db.get(Launcher, self.launcher_id)
            launcher.disconnected_at = utcnow()
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            operation = await db.scalar(select(Operation).where(Operation.user_id == self.owner, Operation.details["automatic_prune"].as_boolean().is_(True)))
            self.assertEqual(operation.stage, "waiting-launcher")
            self.assertEqual(old.state, "present")
            launcher.disconnected_at = None
            await db.commit()
            with patch("optimization.model_maintenance.requested_resources", side_effect=HTTPException(409, "No allocation")):
                await model_maintenance.reconcile_pruning(db)
            self.assertEqual(operation.stage, "waiting-resources")
            self.assertEqual(old.state, "present")
            self.assertIsNone(await db.scalar(select(Job.id).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner)))
            await model_maintenance.reconcile_pruning(db)
            self.assertEqual(operation.stage, "queued")

    async def test_attempt_authority_rechecks_pins_and_exact_receipt_preserves_later_restore(self):
        async with self.sessions() as db:
            old = await self.generated(db, 2)
            await self.generated(db, 3)
            await model_maintenance.reconcile_pruning(db)
            job = await db.scalar(select(Job).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner))
            inference = Job(id=str(uuid4()), user_id=self.owner, slave_app_id="predictor", handler_type="predictor",
                job_mode="webrtc", state="running", launcher_id=self.launcher_id, progress=[])
            db.add(inference)
            await db.commit()
            body = ModelLeaseRequest(job_id=inference.id, revision=2, storage_id=self.storage_id, replica_id=old.id)
            self.assertEqual(await lease_model(db, self.model_id, body, self.owner), {"leased": True})
            await lease_model(db, self.model_id, body, self.owner, release=True)
            token = "prune-fixture-worker"
            job.worker_token_hash = hashlib.sha256(token.encode()).hexdigest()
            await db.commit()
            with self.assertRaises(HTTPException):
                await model_maintenance.access(UUID(job.id), UUID(job.attempt_id), "Bearer " + token, db)
            job.state, job.launcher_id = "running", self.launcher_id
            await db.commit()
            for attempt, credential in ((uuid4(), token), (UUID(job.attempt_id), "wrong")):
                with self.assertRaises(HTTPException):
                    await model_maintenance.access(UUID(job.id), attempt, "Bearer " + credential, db)
            pin = await self.pin(db, old)
            with self.assertRaises(HTTPException):
                await model_maintenance.access(UUID(job.id), UUID(job.attempt_id), "Bearer " + token, db)
            self.assertEqual(old.state, "present")
            await db.delete(pin)
            await db.commit()
            result = await model_maintenance.access(UUID(job.id), UUID(job.attempt_id), "Bearer " + token, db)
            operation = await db.get(Operation, job.input["operationId"])
            self.assertEqual(result["grant"]["operation_id"], operation.id)
            self.assertEqual(old.state, "deleting")
            receipt = {"operationId": operation.id, "replicaId": old.id, "removed": True}
            with self.assertRaises(ValueError):
                await model_maintenance.complete_job(db, job, receipt)
            await operations.complete_operation(db, operation, OperationComplete(replica_id=old.id))
            with self.assertRaises(ValueError):
                await model_maintenance.complete_job(db, job, {**receipt, "replicaId": str(uuid4())})
            self.assertEqual((await model_maintenance.complete_job(db, job, receipt))["replica_id"], old.id)
            job.state, job.cleaned_at = "succeeded", utcnow()
            old.state, old.delete_id = "present", None
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertEqual(old.state, "present")
            self.assertEqual(await db.scalar(select(func.count()).select_from(Job).where(
                Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner)), 1)

    async def test_interrupted_before_access_can_retry_through_existing_operation_grant(self):
        async with self.sessions() as db:
            old = await self.generated(db, 2)
            await self.generated(db, 3)
            await model_maintenance.reconcile_pruning(db)
            job = await db.scalar(select(Job).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner))
            operation = await db.get(Operation, job.input["operationId"])
            job.state, job.launcher_id = "failed", self.launcher_id
            await model_maintenance.on_finished(db, job)
            await db.commit()
            with self.assertRaises(HTTPException):
                await operations.issue_grant(db, operation, retry=True)
            job.cleaned_at = utcnow()
            await db.commit()
            grant = await operations.issue_grant(db, operation, retry=True)
            manifest = await operations.transfer_manifest(db, operation)
            self.assertEqual(grant["operation_id"], operation.id)
            self.assertEqual(operation.details["replica_id"], old.id)
            self.assertEqual([replica["id"] for replica in manifest["operation"]["replicas"]], [old.id])
            self.assertEqual(old.state, "deleting")
            operation.details = {**operation.details, "prune_retry_at": 0}
            operation.expires_at = utcnow() - timedelta(seconds=30)
            await db.commit()
            await operations.expire_operation(db, operation)
            self.assertEqual(operation.state, "interrupted")
            await model_maintenance.reconcile_pruning(db)
            self.assertEqual(await db.scalar(select(func.count()).select_from(Job).where(
                Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner)), 1)
            await operations.complete_operation(db, operation, OperationComplete(replica_id=old.id))
            self.assertEqual(operation.state, "completed")

    async def test_pin_acquired_after_queue_retries_on_server_after_release_and_cleanup(self):
        async with self.sessions() as db:
            old = await self.generated(db, 2)
            await self.generated(db, 3)
            await model_maintenance.reconcile_pruning(db)
            first = await db.scalar(select(Job).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner))
            operation = await db.get(Operation, first.input["operationId"])
            first.state, first.launcher_id = "running", self.launcher_id
            first.worker_token_hash = hashlib.sha256(b"first-prune-worker").hexdigest()
            await db.commit()
            pin = await self.pin(db, old)
            with self.assertRaises(HTTPException) as blocked:
                await model_maintenance.access(UUID(first.id), UUID(first.attempt_id), "Bearer first-prune-worker", db)
            self.assertEqual(blocked.exception.status_code, 409)
            first.state, first.last_error = "failed", "Copy acquired an Optimization pin."
            await model_maintenance.on_finished(db, first)
            await db.commit()
            self.assertEqual(operation.details["prune_retry_count"], 1)
            generation = operation.details["grant_generation"]
            await model_maintenance.on_finished(db, first)
            self.assertEqual(operation.details["prune_retry_count"], 1)
            self.assertEqual(operation.details["grant_generation"], generation)
            operation.details = {**operation.details, "prune_retry_at": 0}
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertEqual(operation.details["prune_job_id"], first.id)
            first.cleaned_at = utcnow()
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertEqual(operation.details["prune_job_id"], first.id)
            self.assertEqual(old.state, "present")
            await db.delete(pin)
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            second = await db.get(Job, operation.details["prune_job_id"])
            self.assertNotEqual(second.id, first.id)
            self.assertNotEqual(second.attempt_id, first.attempt_id)
            self.assertEqual(operation.state, "pending")
            self.assertEqual(old.state, "present")
            with self.assertRaises(HTTPException):
                await model_maintenance.access(UUID(first.id), UUID(first.attempt_id), "Bearer first-prune-worker", db)
            second.state, second.launcher_id = "running", self.launcher_id
            second.worker_token_hash = hashlib.sha256(b"second-prune-worker").hexdigest()
            await db.commit()
            await model_maintenance.access(UUID(second.id), UUID(second.attempt_id), "Bearer second-prune-worker", db)
            await operations.complete_operation(db, operation, OperationComplete(replica_id=old.id))
            receipt = {"operationId": operation.id, "replicaId": old.id, "removed": True}
            self.assertEqual((await model_maintenance.complete_job(db, second, receipt))["replica_id"], old.id)

    async def test_physical_delete_failure_retries_same_tombstone_with_fresh_grant(self):
        async with self.sessions() as db:
            old = await self.generated(db, 2)
            await self.generated(db, 3)
            await model_maintenance.reconcile_pruning(db)
            first = await db.scalar(select(Job).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner))
            operation = await db.get(Operation, first.input["operationId"])
            first.state, first.launcher_id = "running", self.launcher_id
            first.worker_token_hash = hashlib.sha256(b"first-prune-worker").hexdigest()
            await db.commit()
            old_grant = (await model_maintenance.access(UUID(first.id), UUID(first.attempt_id), "Bearer first-prune-worker", db))["grant"]
            self.assertEqual(old.state, "deleting")
            self.assertEqual(old.delete_id, operation.id)
            first.state, first.last_error = "failed", "Physical file deletion was temporarily unavailable."
            await model_maintenance.on_finished(db, first)
            first.cleaned_at = utcnow()
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertEqual(operation.details["prune_job_id"], first.id)
            operation.details = {**operation.details, "prune_retry_at": 0, "grant_deadline": 1}
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            second = await db.get(Job, operation.details["prune_job_id"])
            self.assertNotEqual(second.id, first.id)
            self.assertNotIn("grant_deadline", operation.details)
            with self.assertRaises(HTTPException) as stale:
                await operations.granted_operation(db, UUID(operation.id), "Bearer " + old_grant["token"], renew=True)
            self.assertEqual(stale.exception.status_code, 410)
            second.state, second.launcher_id = "running", self.launcher_id
            second.worker_token_hash = hashlib.sha256(b"second-prune-worker").hexdigest()
            await db.commit()
            new_grant = (await model_maintenance.access(UUID(second.id), UUID(second.attempt_id), "Bearer second-prune-worker", db))["grant"]
            self.assertGreater(new_grant["expires_at"], utcnow().timestamp())
            self.assertEqual(old.delete_id, operation.id)
            await operations.complete_operation(db, operation, OperationComplete(replica_id=old.id))
            self.assertEqual((await model_maintenance.complete_job(db, second,
                {"operationId": operation.id, "replicaId": old.id, "removed": True}))["replica_id"], old.id)
            second.state, second.cleaned_at = "succeeded", utcnow()
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertEqual(operation.details["prune_job_id"], second.id)

    async def test_access_waits_for_concurrent_browser_lease_before_deleting_copy(self):
        async with self.sessions() as db:
            old = await self.generated(db, 2)
            await self.generated(db, 3)
            await model_maintenance.reconcile_pruning(db)
            cleanup = await db.scalar(select(Job).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner))
            cleanup.state, cleanup.launcher_id = "running", self.launcher_id
            cleanup.worker_token_hash = hashlib.sha256(b"prune-worker").hexdigest()
            inference = Job(id=str(uuid4()), user_id=self.owner, slave_app_id="predictor", handler_type="predictor",
                job_mode="webrtc", state="running", launcher_id=self.launcher_id, progress=[])
            db.add(inference)
            await db.commit()
            async with self.sessions() as lease_db, self.sessions() as worker_db:
                await model_maintenance.owned(lease_db, PredictionModel, self.model_id, self.owner)
                lease_db.add(ModelLease(model_id=self.model_id, revision=2, job_id=inference.id,
                    storage_id=self.storage_id, replica_id=old.id))
                await lease_db.flush()
                access = asyncio.create_task(model_maintenance.access(UUID(cleanup.id), UUID(cleanup.attempt_id),
                    "Bearer prune-worker", worker_db))
                try:
                    with self.assertRaises(asyncio.TimeoutError):
                        await asyncio.wait_for(asyncio.shield(access), timeout=0.1)
                    await lease_db.commit()
                    with self.assertRaises(HTTPException) as blocked:
                        await asyncio.wait_for(access, timeout=2)
                    self.assertEqual(blocked.exception.status_code, 409)
                finally:
                    if not access.done():
                        access.cancel()
                        await asyncio.gather(access, return_exceptions=True)
            await db.refresh(old)
            self.assertEqual(old.state, "present")

    async def test_manual_evaluation_retry_and_prediction_parent_retain_exact_copy_until_cleanup(self):
        async with self.sessions() as db:
            old = await self.generated(db, 2)
            await self.generated(db, 3)
            optimization = Optimization(id=str(uuid4()), user_id=self.owner, experiment_id=self.experiment_id,
                name="Completed Optimization", request_id=str(uuid4()), request_hash="evaluation-fixture",
                state="completed", definition={"hash": "preserved"}, settings={}, optimizer_state={})
            db.add(optimization)
            await db.flush()
            trial = Trial(id=str(uuid4()), optimization_id=optimization.id, ordinal=1, variables={},
                fingerprint="historical-candidate", state="succeeded", next_stage="complete")
            db.add(trial)
            await db.flush()
            source = {"model_id": self.model_id, "model_revision": 2, "replica_id": old.id,
                "storage_id": old.storage_id}
            evaluation = Evaluation(id=str(uuid4()), optimization_id=optimization.id, trial_id=trial.id,
                fingerprint=trial.fingerprint, kind="prediction", definition_hash="preserved",
                source_hash="historical-model", source=source, state="pending", next_stage="predict",
                manual_retry_requested=True)
            db.add(evaluation)
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertIsNone(await db.scalar(select(Job.id).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner)))
            evaluation.manual_retry_requested = False
            evaluation.state, evaluation.next_stage = "succeeded", "complete"
            parent = Job(id=str(uuid4()), user_id=self.owner, slave_app_id="evaluation", handler_type="cae.evaluation.predict",
                job_mode="websocket", state="queued", target_launcher_id=self.launcher_id,
                input={"stage": "predict", "hybrid": source}, progress=[])
            db.add(parent)
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertIsNone(await db.scalar(select(Job.id).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner)))
            parent.state, parent.launcher_id = "failed", self.launcher_id
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertIsNone(await db.scalar(select(Job.id).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner)))
            parent.cleaned_at = utcnow()
            await db.commit()
            await model_maintenance.reconcile_pruning(db)
            self.assertEqual(old.state, "present")
            self.assertIsNotNone(await db.scalar(select(Job.id).where(Job.handler_type == model_maintenance.HANDLER, Job.user_id == self.owner)))
            self.assertEqual(evaluation.state, "succeeded")


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class OptimizationModelPinMigrationTests(unittest.TestCase):
    def test_populated_revision27_backfills_live_pins_without_changing_definition_or_evaluations(self):
        database = f"caemble_calculation_test_{uuid4().hex}"
        asyncio.run(_create_database(database))
        self.addCleanup(lambda: asyncio.run(_drop_database(database)))
        _upgrade(database, "000000000027")
        owner, _, experiment, _ = asyncio.run(_seed_owners(database))
        identities = [str(uuid4()) for _ in range(3)]
        hybrid = {"model_id": str(uuid4()), "model_revision": 7, "replica_id": str(uuid4()), "storage_id": str(uuid4())}

        async def seed():
            connection = await asyncpg.connect(**_connect_arguments(database))
            try:
                for identity, state in zip(identities, ("paused", "completed", "running")):
                    definition = {"hash": "retained-definition", **({"hybrid": hybrid} if state != "running" else {})}
                    await connection.execute("INSERT INTO cae_optimizations "
                        "(id,user_id,experiment_id,name,request_id,request_hash,state,definition,settings,optimizer_state) "
                        "VALUES ($1,$2,$3,'Retained',$4,'request-hash',$5,$6,'{}',$7)", identity, owner, experiment,
                        str(uuid4()), state, json.dumps(definition), json.dumps({"runtime_id": "unchanged", "round_index": 3}))
                trial = str(uuid4())
                await connection.execute("INSERT INTO cae_trials "
                    "(id,optimization_id,ordinal,round_index,variables,fingerprint,state,next_stage) "
                    "VALUES ($1,$2,1,3,'{}','candidate','succeeded','complete')", trial, identities[0])
                await connection.execute("INSERT INTO cae_evaluations "
                    "(id,optimization_id,trial_id,fingerprint,kind,definition_hash,source_hash,source,state,next_stage,result) "
                    "VALUES ($1,$2,$3,'candidate','prediction','retained-definition','old-model',$4,'succeeded','complete',$5)",
                    str(uuid4()), identities[0], trial, json.dumps(hybrid), json.dumps({"objective": 7}))
            finally:
                await connection.close()

        async def snapshot():
            connection = await asyncpg.connect(**_connect_arguments(database))
            try:
                rows = [json.loads(row[0]) for row in await connection.fetch("SELECT to_jsonb(t) FROM cae_optimizations t ORDER BY id")]
                evaluations = [json.loads(row[0]) for row in await connection.fetch("SELECT to_jsonb(t) FROM cae_evaluations t")]
                return rows, evaluations
            finally:
                await connection.close()

        asyncio.run(seed())
        before, evaluations = asyncio.run(snapshot())
        _upgrade(database, "000000000028")
        _check(database)
        after, retained_evaluations = asyncio.run(snapshot())
        self.assertEqual(retained_evaluations, evaluations)
        for old, new in zip(before, after):
            state = new.pop("optimizer_state")
            old_state = old.pop("optimizer_state")
            self.assertEqual(new, old)
            self.assertEqual({key: state[key] for key in old_state}, old_state)
            if "hybrid" in old["definition"]:
                self.assertEqual(state["model_update"]["active_model"], hybrid)

        async def pins():
            connection = await asyncpg.connect(**_connect_arguments(database))
            try:
                return [dict(row) for row in await connection.fetch("SELECT optimization_id::text,slot,model_id::text,revision,replica_id::text,storage_id::text FROM cae_optimization_model_pins ORDER BY slot")]
            finally:
                await connection.close()
        self.assertEqual(asyncio.run(pins()), [{"optimization_id": identities[0], "slot": slot,
            "model_id": hybrid["model_id"], "revision": 7, "replica_id": hybrid["replica_id"],
            "storage_id": hybrid["storage_id"]} for slot in ("active", "round")])
