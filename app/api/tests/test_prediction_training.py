"""Durable training admission, publication and cleanup using disposable PostgreSQL."""
import asyncio
import os
import unittest
from datetime import timedelta
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import func, select

from gpstation.db import Job, Launcher
from gpstation.service.batches import finish_job, serialize_events
from gpstation.service.server_handlers import register_server_handler, server_handlers
from gpstation.service.state import utcnow
from prediction import training
from prediction.common import require_dataset_idle
from prediction.datasets import dataset_change_set, freeze_dataset, retire_server_payloads
from prediction.db import Dataset, DatasetObject, DatasetRevision, ModelRevision, Operation, Replica, TrainingRun
from prediction.grants import create_grant, read_granted_revision, release_grant, renew_grant
from prediction.models import complete_model, model_view, reserve_model
from prediction.operations import expire_operation, list_operations
import test_prediction_assets as assets
from simulation.db import Measurement, RecordedData


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class PredictionTrainingTests(unittest.IsolatedAsyncioTestCase):
    setUpClass = classmethod(assets.PredictionAssetsTests.setUpClass.__func__)
    tearDownClass = classmethod(assets.PredictionAssetsTests.tearDownClass.__func__)
    selection = assets.PredictionAssetsTests.selection
    model_request = assets.PredictionAssetsTests.model_request
    completion = assets.PredictionAssetsTests.completion

    async def asyncSetUp(self):
        await assets.PredictionAssetsTests.asyncSetUp(self)
        self.previous_handler = server_handlers.get(training.HANDLER)
        register_server_handler(training.HANDLER, training, on_finished=training.on_finished)
        async with self.sessions() as db:
            launcher = await db.get(Launcher, self.launcher_id)
            launcher.slave_app_ids = ["predictor", "predictor-training"]
            launcher.job_modes = {"predictor": "webrtc", "predictor-training": "websocket"}
            launcher.resources = {"cpu_total": 4, "ram_budget_bytes": 2 ** 30,
                "defaults": {"predictor-training": {"startup_ram_bytes": 2 ** 20}}}
            await db.commit()

    async def asyncTearDown(self):
        if self.previous_handler is None:
            server_handlers.pop(training.HANDLER, None)
        else:
            server_handlers[training.HANDLER] = self.previous_handler
        await assets.PredictionAssetsTests.asyncTearDown(self)

    async def reserve(self, db):
        dataset = await freeze_dataset(db, self.selection(), self.owner)
        definition = {"algorithm": {"kind": "knn", "kMode": "auto", "manualK": 1, "weighting": "distance"},
            "implementationVersion": "knn-v1", "preprocessingVersion": "box-relative-v2",
            "fingerprint": "sha256:" + "c" * 64, "snapshotFingerprint": dataset["revisions"][0]["fingerprint"]}
        reserved = await reserve_model(db, self.model_request(dataset, definition=definition), self.owner)
        return dataset, reserved

    async def reserve_update(self, db, *, online_origin=None):
        dataset, initial = await self.reserve(db)
        await complete_model(db, initial["id"], 1, self.completion(initial["operation_id"]), self.owner)
        original = await db.get(ModelRevision, (initial["id"], 1))
        replica = await db.scalar(select(Replica).where(Replica.model_id == initial["id"], Replica.revision == 1))
        measurement = Measurement(user_id=self.owner, experiment_id=self.experiment_id,
            vars={"width": 3}, material_snapshot={}, recorded_at=utcnow())
        db.add(measurement)
        await db.flush()
        db.add(RecordedData(user_id=self.owner, measurement_id=measurement.id, experiment_record_id=self.record_id,
            data={"shape": [2], "storage": {"kind": "inline", "value": self.ref}}))
        await db.flush()
        target = await freeze_dataset(db, self.selection(expected_revision=1), self.owner, dataset["id"], online=True)
        base_ref = {"datasetId": dataset["id"], "revision": 1, "fingerprint": original.dataset_fingerprint}
        target_ref = {"datasetId": dataset["id"], "revision": 2, "fingerprint": target["revisions"][0]["fingerprint"]}
        update = {"mode": "rebuild", "baseModel": {"modelId": initial["id"], "revision": 1,
            "checksum": original.artifact["manifest_sha256"], "storageId": self.storage_id, "replicaId": replica.id},
            "targetSnapshot": target_ref, "changeSet": await dataset_change_set(db, base_ref, target_ref, self.owner), "recipe": {}}
        definition = {**original.definition, "snapshotFingerprint": target_ref["fingerprint"]}
        reserved = await reserve_model(db, self.model_request(target, model_id=initial["id"], expected_revision=1,
            definition=definition, training_update=update), self.owner, online_origin=online_origin, force_api_source=True)
        return target, reserved, update

    async def mark_failed(self, db, job, *, cleaning=False):
        await serialize_events(db)
        if cleaning:
            job.launcher_id = self.launcher_id
        await finish_job(db, job, "failed", "worker disconnected")
        await db.commit()

    def artifact(self, reserved, revision):
        body = self.completion(reserved["operation_id"])
        return {"modelId": reserved["id"], "revision": reserved["reserved_revision"],
            "name": reserved["revisions"][0].get("version_name") or reserved["name"],
            "operationId": reserved["operation_id"], "datasetId": revision.dataset_id,
            "datasetRevision": revision.dataset_revision, "datasetFingerprint": revision.dataset_fingerprint,
            "definition": revision.definition, "storageId": self.storage_id, "launcherId": self.launcher_id,
            "algorithm": "knn", "direction": "forward", "manifestChecksum": body.manifest_sha256,
            "files": [item.model_dump() for item in body.files], "profile": body.profile,
            "inputLayouts": [], "outputLayouts": [], "formatVersion": 1}

    async def test_submit_is_durable_idempotent_and_blocks_sync_through_cleanup(self):
        async with self.sessions() as db:
            dataset, reserved = await self.reserve(db)
            result = await training.submit(db, reserved["operation_id"], self.owner)
            replay = await training.submit(db, reserved["operation_id"], self.owner)
            self.assertEqual(result["training"]["jobId"], replay["training"]["jobId"])
            operation = await db.get(Operation, reserved["operation_id"])
            operation.expires_at = utcnow() - timedelta(days=1)
            await expire_operation(db, operation)
            self.assertEqual(operation.state, "queued")
            await db.commit()
        async with self.sessions() as db:
            with self.assertRaises(HTTPException):
                await freeze_dataset(db, self.selection(expected_revision=1), self.owner, dataset["id"])
            await db.rollback()
            job = await db.get(Job, result["training"]["jobId"])
            await self.mark_failed(db, job, cleaning=True)
            with self.assertRaises(HTTPException):
                await require_dataset_idle(db, dataset["id"])
            job.cleaned_at = utcnow()
            await db.flush()
            await require_dataset_idle(db, dataset["id"])

    async def test_retry_nonce_deduplicates_and_old_pin_only_releases_itself(self):
        async with self.sessions() as db:
            _, reserved = await self.reserve(db)
            old_grant = reserved["training"]["grant"]
            initial = await training.submit(db, reserved["operation_id"], self.owner)
            job = await db.get(Job, initial["training"]["jobId"])
            await self.mark_failed(db, job)
            nonce = str(uuid4())
            preflight = await training.preflight(db, reserved["operation_id"], nonce, self.owner)
            self.assertNotEqual(initial["training"]["pinId"], preflight["training"]["pinId"])
            _, _, old_scope = await training.authority(db, reserved["operation_id"], "Bearer " + old_grant["token"])
            self.assertEqual(old_scope["pinId"], initial["training"]["pinId"])
            self.assertTrue(old_scope["canRelease"])
            self.assertFalse(old_scope["canPin"])
            result = await training.submit(db, reserved["operation_id"], self.owner, retry_request_id=nonce)
            replay = await training.submit(db, reserved["operation_id"], self.owner, retry_request_id=nonce)
            self.assertEqual(result["training"]["jobId"], replay["training"]["jobId"])
            self.assertNotEqual(job.id, result["training"]["jobId"])
            self.assertEqual(await db.scalar(select(func.count()).select_from(Job).where(Job.user_id == self.owner)), 2)

    async def test_local_admission_requires_ack_and_rejects_old_pin(self):
        async with self.sessions() as db:
            _, reserved = await self.reserve(db)
            run = await db.get(TrainingRun, reserved["operation_id"])
            run.source_kind = "local"
            pin_id = run.pin_id
            await db.commit()
            with self.assertRaises(HTTPException):
                await training.submit(db, reserved["operation_id"], self.owner, pin_id=run.pin_id)
            await db.rollback()
            await training.acknowledge_pin(db, reserved["operation_id"], "Bearer " + reserved["training"]["grant"]["token"], pin_id, True)
            result = await training.submit(db, reserved["operation_id"], self.owner, pin_id=pin_id)
            self.assertEqual(result["state"], "queued")

    async def test_public_complete_cannot_publish_and_server_publication_is_atomic(self):
        async with self.sessions() as db:
            _, reserved = await self.reserve(db)
            with self.assertRaises(HTTPException) as error:
                await complete_model(db, reserved["id"], 1, self.completion(reserved["operation_id"]), self.owner, publish=False)
            self.assertEqual(error.exception.status_code, 410)
            await db.rollback()
            result = await training.submit(db, reserved["operation_id"], self.owner)
            job = await db.get(Job, result["training"]["jobId"])
            job.launcher_id = self.launcher_id
            revision = await db.get(ModelRevision, (reserved["id"], 1))
            await training.complete_job(db, job, {"artifact": self.artifact(reserved, revision)})
            await db.rollback()
        async with self.sessions() as db:
            revision = await db.get(ModelRevision, (reserved["id"], 1))
            self.assertEqual(revision.state, "reserved")
            job = await db.get(Job, result["training"]["jobId"])
            job.launcher_id = self.launcher_id
            receipt = await training.complete_job(db, job, {"artifact": self.artifact(reserved, revision)})
            await finish_job(db, job, "succeeded", result=receipt)
            await db.commit()
            self.assertEqual((await db.get(Operation, reserved["operation_id"])).state, "completed")
            self.assertEqual((await db.get(ModelRevision, (reserved["id"], 1))).state, "ready")
            await complete_model(db, reserved["id"], 1, self.completion(reserved["operation_id"]), self.owner, publish=False)

    async def test_cancel_fences_late_completion_and_waits_for_cleanup(self):
        async with self.sessions() as db:
            _, reserved = await self.reserve(db)
            result = await training.submit(db, reserved["operation_id"], self.owner)
            job = await db.get(Job, result["training"]["jobId"])
            job.launcher_id = self.launcher_id
            row = await db.get(Operation, reserved["operation_id"])
            await training.cancel(db, row)
            await db.commit()
            self.assertEqual(job.state, "cancelled")
            self.assertTrue((await training.operation_view(db, row))["training"]["cleanupPending"])
            with self.assertRaises(ValueError):
                await training.complete_job(db, job, {"artifact": {}})
            with self.assertRaises(HTTPException):
                await training.preflight(db, row.id, str(uuid4()), self.owner)

    async def test_saved_artifact_retry_survives_dataset_retirement(self):
        async with self.sessions() as db:
            dataset, reserved = await self.reserve(db)
            first = await training.submit(db, reserved["operation_id"], self.owner)
            await self.mark_failed(db, await db.get(Job, first["training"]["jobId"]))
            source = await db.get(DatasetRevision, (dataset["id"], 1))
            source.payload = None
            (await db.get(Dataset, dataset["id"])).state = "deleted"
            await db.commit()
            nonce = str(uuid4())
            prepared = await training.preflight(db, reserved["operation_id"], nonce, self.owner)
            await training.acknowledge_pin(db, reserved["operation_id"], "Bearer " + prepared["training"]["grant"]["token"],
                prepared["training"]["pinId"], True)
            retried = await training.submit(db, reserved["operation_id"], self.owner, retry_request_id=nonce)
            self.assertEqual(retried["state"], "queued")

    async def test_old_active_operation_is_included_beyond_recent_history(self):
        async with self.sessions() as db:
            _, reserved = await self.reserve(db)
            await training.submit(db, reserved["operation_id"], self.owner)
            old = await db.get(Operation, reserved["operation_id"])
            old.created_at = utcnow() - timedelta(days=30)
            for _ in range(101):
                identity = str(uuid4())
                db.add(Operation(id=identity, request_id=identity, request_hash="fixture", user_id=self.owner,
                    kind="verify", asset_kind="model", asset_id=reserved["id"], revision=1,
                    experiment_id=self.experiment_id, state="completed", stage="completed", details={}))
            await db.commit()
            response = await list_operations(db, self.owner)
            self.assertIn(old.id, {item["id"] for item in response["items"]})

    async def test_abandoned_preflight_expires_without_expiring_submitted_training(self):
        async with self.sessions() as db:
            _, reserved = await self.reserve(db)
            row = await db.get(Operation, reserved["operation_id"])
            run = await db.get(TrainingRun, row.id)
            run.preflight_expires_at = utcnow() - timedelta(seconds=1)
            await db.commit()
            await expire_operation(db, row)
            self.assertEqual(row.state, "interrupted")
            _, _, scope = await training.authority(db, row.id, "Bearer " + reserved["training"]["grant"]["token"])
            self.assertFalse(scope["canPin"])
            self.assertTrue(scope["canRelease"])
            with self.assertRaises(HTTPException):
                await training.submit(db, row.id, self.owner)
            await db.rollback()
            nonce = str(uuid4())
            await training.preflight(db, reserved["operation_id"], nonce, self.owner)
            result = await training.submit(db, reserved["operation_id"], self.owner, retry_request_id=nonce)
            self.assertEqual(result["state"], "queued")

    async def test_retry_waits_for_process_cleanup_and_rejects_stale_authority_ack(self):
        async with self.sessions() as db:
            _, reserved = await self.reserve(db)
            result = await training.submit(db, reserved["operation_id"], self.owner)
            job = await db.get(Job, result["training"]["jobId"])
            await self.mark_failed(db, job, cleaning=True)
            nonce = str(uuid4())
            with self.assertRaises(HTTPException):
                await training.preflight(db, reserved["operation_id"], nonce, self.owner)
            job.cleaned_at = utcnow()
            await db.commit()
            fresh = await training.preflight(db, reserved["operation_id"], nonce, self.owner)
            with self.assertRaises(HTTPException):
                await training.acknowledge_pin(db, reserved["operation_id"], "Bearer " + reserved["training"]["grant"]["token"],
                    fresh["training"]["pinId"])

    async def test_abandoned_retry_preflight_expires_and_hides_previous_progress(self):
        for previous_state in ("failed", "cancelled"):
            with self.subTest(previous_state=previous_state):
                async with self.sessions() as db:
                    _, reserved = await self.reserve(db)
                    submitted = await training.submit(db, reserved["operation_id"], self.owner)
                    job = await db.get(Job, submitted["training"]["jobId"])
                    job.progress = [{"progress": {"stage": "saving"}}]
                    if previous_state == "failed":
                        await self.mark_failed(db, job)
                    else:
                        await training.cancel(db, await db.get(Operation, reserved["operation_id"]))
                        await db.commit()
                    fresh = await training.preflight(db, reserved["operation_id"], str(uuid4()), self.owner)
                    self.assertEqual((fresh["state"], fresh["stage"]), ("pending", "preparing"))
                    self.assertNotIn("progress", fresh["training"])
                    row = await db.get(Operation, reserved["operation_id"])
                    (await db.get(TrainingRun, row.id)).preflight_expires_at = utcnow() - timedelta(seconds=1)
                    await db.commit()
                    await expire_operation(db, row)
                    self.assertEqual(row.state, "interrupted")
                    _, _, scope = await training.authority(db, row.id, "Bearer " + fresh["training"]["grant"]["token"])
                    self.assertFalse(scope["canPin"])
                    self.assertTrue(scope["canRelease"])

    async def test_explicit_cancel_can_restart_after_cleanup_but_superseded_revision_cannot(self):
        async with self.sessions() as db:
            _, reserved = await self.reserve(db)
            submitted = await training.submit(db, reserved["operation_id"], self.owner)
            row = await db.get(Operation, reserved["operation_id"])
            await training.cancel(db, row)
            await db.commit()
            nonce = str(uuid4())
            await training.preflight(db, row.id, nonce, self.owner)
            retried = await training.submit(db, row.id, self.owner, retry_request_id=nonce)
            self.assertNotEqual(retried["training"]["jobId"], submitted["training"]["jobId"])
            await training.cancel(db, row)
            (await db.get(ModelRevision, (reserved["id"], 1))).state = "abandoned"
            await db.commit()
            with self.assertRaises(HTTPException) as rejected:
                await training.preflight(db, row.id, str(uuid4()), self.owner)
            self.assertEqual(rejected.exception.status_code, 410)

    async def test_public_job_control_and_unowned_training_credentials_are_rejected(self):
        async with self.sessions() as db:
            _, reserved = await self.reserve(db)
            submitted = await training.submit(db, reserved["operation_id"], self.owner)
            with self.assertRaises(HTTPException):
                await training.require_unmanaged_job(db, submitted["training"]["jobId"], self.owner)
            with self.assertRaises(HTTPException):
                await training.dataset_access(db, submitted["training"]["jobId"], str(uuid4()), "Bearer stale")
            with self.assertRaises(HTTPException):
                await training.submit(db, reserved["operation_id"], self.other)

    async def test_completion_and_cancel_race_publish_one_consistent_outcome(self):
        async with self.sessions() as db:
            _, reserved = await self.reserve(db)
            submitted = await training.submit(db, reserved["operation_id"], self.owner)
            job_id = submitted["training"]["jobId"]
            job = await db.get(Job, job_id)
            job.state, job.launcher_id = "finalizing", self.launcher_id
            artifact = self.artifact(reserved, await db.get(ModelRevision, (reserved["id"], 1)))
            await db.commit()

        async def publish():
            async with self.sessions() as db:
                await serialize_events(db)
                job = await db.scalar(select(Job).where(Job.id == job_id).with_for_update())
                if job.state == "cancelled":
                    return
                result = await training.complete_job(db, job, {"artifact": artifact})
                await finish_job(db, job, "succeeded", result=result)
                await db.commit()

        async def cancel():
            async with self.sessions() as db:
                await training.cancel_operation(db, reserved["operation_id"], self.owner)

        await asyncio.wait_for(asyncio.gather(publish(), cancel()), timeout=5)
        async with self.sessions() as db:
            row = await db.get(Operation, reserved["operation_id"])
            revision = await db.get(ModelRevision, (reserved["id"], 1))
            job = await db.get(Job, job_id)
            self.assertIn((row.state, revision.state, job.state), {
                ("completed", "ready", "succeeded"), ("cancelled", "reserved", "cancelled")})

    async def test_support_is_reported_for_each_immutable_revision(self):
        from prediction.db import PredictionModel
        async with self.sessions() as db:
            _, reserved = await self.reserve(db)
            row = await db.get(PredictionModel, reserved["id"])
            first = await db.get(ModelRevision, (row.id, 1))
            db.add(ModelRevision(model_id=row.id, revision=2, request_id=str(uuid4()), request_hash="fixture", state="ready",
                dataset_id=first.dataset_id, dataset_revision=first.dataset_revision,
                dataset_fingerprint=first.dataset_fingerprint,
                definition={**first.definition, "implementationVersion": "future-version"},
                source_contracts=first.source_contracts, artifact=first.artifact))
            row.current_revision = 2
            await db.flush()
            response = await model_view(db, row)
            self.assertEqual(response["support_status"], "unsupported")
            self.assertEqual({item["revision"]: item["support_status"] for item in response["revisions"]},
                {1: "supported", 2: "unsupported"})

    async def test_online_freeze_retains_old_training_and_scoped_readers(self):
        async with self.sessions() as db:
            dataset, reserved = await self.reserve(db)
            submitted = await training.submit(db, reserved["operation_id"], self.owner)
            grant = await create_grant(db, dataset["id"], 1, self.owner)
            measurement = await db.get(Measurement, self.measurement_id)
            measurement.vars = {"width": 4}
            await db.commit()
            changed = await freeze_dataset(db, self.selection(expected_revision=1), self.owner, dataset["id"], online=True)
            self.assertEqual(changed["current_revision"], 2)
            old = await read_granted_revision(db, dataset["id"], 1, "Bearer " + grant["token"])
            self.assertEqual(old.payload["measurements"][0]["vars"], {"width": 2})
            renewed = await renew_grant(db, dataset["id"], 1, "Bearer " + grant["token"])
            self.assertEqual(renewed["manifest_sha256"], grant["manifest_sha256"])
            self.assertIsNotNone(await db.get(DatasetObject, (dataset["id"], 1, self.object_id)))
            with self.assertRaises(HTTPException):
                await create_grant(db, dataset["id"], 1, self.owner)
            await self.mark_failed(db, await db.get(Job, submitted["training"]["jobId"]))
            await release_grant(db, dataset["id"], grant["grant_id"], self.owner)
            self.assertIsNone((await db.get(DatasetRevision, (dataset["id"], 1))).payload)

    async def test_update_retry_retains_exact_snapshot_across_newer_freezes_and_cleanup(self):
        async with self.sessions() as db:
            target, reserved, update = await self.reserve_update(db,
                online_origin={"optimization_id": 12, "optimization_name": "Fixture"})
            submitted = await training.submit(db, reserved["operation_id"], self.owner)
            measurement = await db.get(Measurement, self.measurement_id)
            measurement.vars = {"width": 5}
            await db.commit()
            newer = await freeze_dataset(db, self.selection(expected_revision=2), self.owner, target["id"], online=True)
            self.assertEqual(newer["current_revision"], 3)
            job = await db.get(Job, submitted["training"]["jobId"])
            await self.mark_failed(db, job, cleaning=True)
            with self.assertRaises(HTTPException):
                await training.preflight(db, reserved["operation_id"], str(uuid4()), self.owner)
            job.cleaned_at = utcnow()
            await db.commit()
            await training.reconcile(db)
            self.assertIsNotNone((await db.get(DatasetRevision, (target["id"], 2))).payload)
            nonce = str(uuid4())
            await training.preflight(db, reserved["operation_id"], nonce, self.owner)
            retried = await training.submit(db, reserved["operation_id"], self.owner, retry_request_id=nonce)
            retried_job = await db.get(Job, retried["training"]["jobId"])
            self.assertEqual(retried_job.input["update"], update)
            self.assertEqual(retried_job.input["dataset"]["revision"], 2)
            await training.cancel(db, await db.get(Operation, reserved["operation_id"]))
            await db.commit()
            await training.reconcile(db)
            self.assertIsNone((await db.get(DatasetRevision, (target["id"], 2))).payload)

    async def test_update_receipt_requires_frozen_lineage_and_verified_reload_prediction(self):
        async with self.sessions() as db:
            _, reserved, update = await self.reserve_update(db)
            submitted = await training.submit(db, reserved["operation_id"], self.owner)
            job = await db.get(Job, submitted["training"]["jobId"])
            job.launcher_id = self.launcher_id
            revision = await db.get(ModelRevision, (reserved["id"], 2))
            artifact = {**self.artifact(reserved, revision), "update": update}
            with self.assertRaises(ValueError):
                await training.complete_job(db, job, {"artifact": artifact})
            validation = {"version": 1, "manifestChecksum": artifact["manifestChecksum"],
                "loadPassed": True, "predictPassed": True, "measurementId": self.measurement_id}
            with self.assertRaises(ValueError):
                await training.complete_job(db, job, {"artifact": {**artifact,
                    "validation": {**validation, "measurementId": -1}}})
            await training.complete_job(db, job, {"artifact": {**artifact, "validation": validation}})
            await db.commit()
            view = await model_view(db, await db.get(assets.PredictionModel, reserved["id"]))
            self.assertEqual(view["current_revision"], 2)
            self.assertEqual(view["revisions"][0]["artifact"]["validation"], validation)
            self.assertEqual(view["revisions"][0]["training_update"], update)

    async def test_snapshot_and_update_reservation_roll_back_together_without_dispatch(self):
        async with self.sessions() as db:
            with self.assertRaises(RuntimeError):
                async with db.begin():
                    dataset = await freeze_dataset(db, self.selection(), self.owner, commit=False, online=True)
                    definition = {"algorithm": {"kind": "knn"}, "implementationVersion": "knn-v1",
                        "preprocessingVersion": "box-relative-v2", "snapshotFingerprint": dataset["revisions"][0]["fingerprint"]}
                    reserved = await reserve_model(db, self.model_request(dataset, definition=definition),
                        self.owner, commit=False, force_api_source=True)
                    submitted = await training.submit(db, reserved["operation_id"], self.owner, commit=False)
                    job_id = submitted["training"]["jobId"]
                    raise RuntimeError("Rollback fixture")
            self.assertIsNone(await db.get(Dataset, dataset["id"]))
            self.assertIsNone(await db.get(Operation, reserved["operation_id"]))
            self.assertIsNone(await db.get(Job, job_id))

    async def test_manual_reservation_cannot_cancel_active_optimization_update(self):
        async with self.sessions() as db:
            target, reserved, _ = await self.reserve_update(db,
                online_origin={"optimization_id": 12, "optimization_name": "Fixture"})
            with self.assertRaises(HTTPException) as busy:
                await reserve_model(db, self.model_request(target, model_id=reserved["id"], expected_revision=1), self.owner)
            self.assertEqual(busy.exception.status_code, 409)
            self.assertEqual((await db.get(Operation, reserved["operation_id"])).state, "pending")
            self.assertEqual((await db.get(ModelRevision, (reserved["id"], 2))).state, "reserved")

    async def test_frozen_name_and_monotonic_publication_do_not_follow_asset_rename(self):
        async with self.sessions() as db:
            _, reserved = await self.reserve(db)
            model = await db.get(assets.PredictionModel, reserved["id"])
            model.name = "Renamed after request"
            model.current_revision = 8
            await db.commit()
            submitted = await training.submit(db, reserved["operation_id"], self.owner)
            job = await db.get(Job, submitted["training"]["jobId"])
            self.assertEqual(job.input["model"]["name"], "Forward model")
            await complete_model(db, model.id, 1, self.completion(reserved["operation_id"]), self.owner)
            self.assertEqual(model.current_revision, 8)

    async def test_failed_optimization_update_retries_after_another_origin_publishes(self):
        async with self.sessions() as db:
            target, first, update = await self.reserve_update(db,
                online_origin={"optimization_id": "origin-a", "optimization_name": "A"})
            submitted = await training.submit(db, first["operation_id"], self.owner)
            await self.mark_failed(db, await db.get(Job, submitted["training"]["jobId"]))
            definition = (await db.get(ModelRevision, (first["id"], 2))).definition
            second = await reserve_model(db, self.model_request(target, model_id=first["id"], expected_revision=1,
                definition=definition, training_update=update), self.owner,
                online_origin={"optimization_id": "origin-b", "optimization_name": "B"}, force_api_source=True)
            second_job = await training.submit(db, second["operation_id"], self.owner)
            job = await db.get(Job, second_job["training"]["jobId"])
            job.launcher_id = self.launcher_id
            revision = await db.get(ModelRevision, (first["id"], 3))
            artifact = {**self.artifact(second, revision), "update": update,
                "validation": {"version": 1, "manifestChecksum": "f" * 64,
                    "loadPassed": True, "predictPassed": True, "measurementId": self.measurement_id}}
            result = await training.complete_job(db, job, {"artifact": artifact})
            await finish_job(db, job, "succeeded", result=result)
            job.cleaned_at = utcnow()
            await db.commit()
            nonce = str(uuid4())
            await training.preflight(db, first["operation_id"], nonce, self.owner)
            retried = await training.submit(db, first["operation_id"], self.owner, retry_request_id=nonce)
            retried_job = await db.get(Job, retried["training"]["jobId"])
            self.assertEqual(retried_job.input["update"], update)
            self.assertEqual((await db.get(assets.PredictionModel, first["id"])).current_revision, 3)
            await training.cancel(db, await db.get(Operation, first["operation_id"]))
            await db.commit()
            third = await reserve_model(db, self.model_request(target, model_id=first["id"], expected_revision=3,
                definition=definition, training_update=update), self.owner,
                online_origin={"optimization_id": "origin-a", "optimization_name": "A"}, force_api_source=True)
            await training.cancel(db, await db.get(Operation, third["operation_id"]))
            await db.commit()
            with self.assertRaises(HTTPException) as superseded:
                await training.preflight(db, first["operation_id"], str(uuid4()), self.owner)
            self.assertEqual(superseded.exception.status_code, 410)
