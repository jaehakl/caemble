"""Real disposable PostgreSQL copy lifecycle with a deterministic object bucket."""
import base64
import asyncio
import hashlib
import threading
import time
from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4
import jwt

from fastapi import HTTPException
from sqlalchemy import select, update

import test_prediction_assets as fixtures
from gpstation.db import Job, Launcher
from gpstation.service.state import utcnow
from prediction import operations
from prediction.datasets import freeze_dataset, preview_source, register_local_dataset
from prediction.db import DatasetRevision, ModelLease, ModelRevision, Operation, OperationObject, Replica
from prediction.lifecycle import register_storage
from prediction.models import complete_model, lease_model, list_models, reserve_model
from prediction.replicas import check_replica
from prediction.schemas import (ArchiveUpload, LocalDatasetRegistration, ModelLeaseRequest, OperationComplete, OperationCreate,
    ReplicaRegistration, StorageRegistration)
from simulation.db import Measurement, RecordedData
from storage.db import StorageObject
from storage.service import cleanup_objects
from settings import settings


class PredictionReplicaTests(fixtures.PredictionAssetsTests):
    async def ready_model(self, db):
        dataset = await freeze_dataset(db, self.selection(), self.owner)
        request = self.model_request(dataset)
        model = await reserve_model(db, request, self.owner)
        model = await complete_model(db, model["id"], 1, self.completion(request.request_id), self.owner)
        return dataset, model

    async def archive(self, db, operation, slot, artifact):
        raw = (slot + " checked archive").encode()
        checksum = hashlib.sha256(raw).hexdigest()
        manifest = {"encoding": "base64", "sha256": checksum, "byteLength": len(raw),
            "chunks": [{"sha256": checksum, "byteLength": len(raw)}]}
        with patch("storage.service.signed_parts", return_value=[]):
            prepared = await operations.prepare_archive(db, operation, slot,
                ArchiveUpload(manifest=manifest, artifact=artifact))
        head = {"ContentLength": len(raw), "ChecksumSHA256": base64.b64encode(bytes.fromhex(checksum)).decode()}
        with patch("storage.service.bucket_client") as client:
            client.return_value.head_object.return_value = head
            await operations.complete_archive(db, operation, slot)
        return prepared

    async def backup(self, db, dataset, model, include_dataset=False):
        response = await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="backup",
            asset_id=model["id"], revision=1, source_replica_id=model["revisions"][0]["replicas"][0]["id"],
            source_launcher_id=self.launcher_id, include_dataset=include_dataset), self.owner)
        operation = await db.get(Operation, response["id"])
        await self.archive(db, operation, "model", model["revisions"][0]["artifact"])
        dataset_artifact = None
        if include_dataset:
            pending = await operations.complete_operation(db, operation, OperationComplete())
            self.assertNotEqual(pending["state"], "completed")
            self.assertEqual(len((await list_models(db, self.owner))["items"][0]["revisions"][0]["replicas"]), 1)
            source = operation.details["dataset_source"]
            dataset_artifact = {"manifest_sha256": source["manifest_sha256"] if source["kind"] != "api_dataset" else "c" * 64,
                "format_version": 1, "files": [{"name": "dataset.json",
                    "sha256": source["payload_sha256"] or "c" * 64, "byteLength": 5}]}
            await self.archive(db, operation, "dataset", dataset_artifact)
        completed = await operations.complete_operation(db, operation, OperationComplete())
        self.assertEqual(completed["state"], "completed")
        return operation, dataset_artifact

    async def second_storage(self, db):
        launcher_id, storage_id = str(uuid4()), str(uuid4())
        db.add(Launcher(id=launcher_id, user_id=self.owner, installation_id=str(uuid4()), launcher_name="Restored",
            status="ready", connected_at=utcnow(), last_heartbeat_at=utcnow(), slave_app_ids=["predictor"]))
        await db.commit()
        await register_storage(db, StorageRegistration(storage_id=storage_id, launcher_id=launcher_id, name="Restored"), self.owner)
        return launcher_id, storage_id

    async def test_backup_restore_same_revision_on_new_launcher_and_retained_old_dataset(self):
        async with self.sessions() as db:
            dataset, model = await self.ready_model(db)
            backup, data_artifact = await self.backup(db, dataset, model, include_dataset=True)
            model_copy = backup.details["result_replicas"]["model"]
            dataset_copy = backup.details["result_replicas"]["dataset"]
            self.assertEqual(len((await db.scalars(select(OperationObject).where(OperationObject.operation_id == backup.id))).all()), 0)
            # Sync retires only the API copy, not the explicitly requested backup.
            db.add(Measurement(user_id=self.owner, experiment_id=self.experiment_id, vars={"width": 3}, material_snapshot={}, recorded_at=utcnow()))
            await db.commit()
            await freeze_dataset(db, self.selection(expected_revision=1), self.owner, dataset["id"])
            self.assertIsNone((await db.get(DatasetRevision, (dataset["id"], 1))).payload)
            launcher_id, storage_id = await self.second_storage(db)
            original = await db.get(Launcher, self.launcher_id)
            original.disconnected_at = utcnow()
            await db.commit()
            response = await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="restore",
                asset_id=model["id"], revision=1, source_replica_id=model_copy, target_storage_id=storage_id,
                target_launcher_id=launcher_id, include_dataset=True, dataset_source_replica_id=dataset_copy), self.owner)
            restore = await db.get(Operation, response["id"])
            complete = await operations.complete_operation(db, restore,
                OperationComplete(model=model["revisions"][0]["artifact"], dataset=data_artifact))
            self.assertEqual(complete["state"], "completed")
            self.assertEqual((await operations.complete_operation(db, restore, OperationComplete()))["id"], restore.id)
            models = (await list_models(db, self.owner))["items"]
            self.assertEqual((len(models), len(models[0]["revisions"])), (1, 1))
            self.assertEqual(len(models[0]["revisions"][0]["replicas"]), 3)
            job = Job(id=str(uuid4()), user_id=self.owner, launcher_id=launcher_id, slave_app_id="predictor",
                handler_type="prediction.session", job_mode="webrtc", state="running")
            db.add(job)
            await db.commit()
            await lease_model(db, model["id"], ModelLeaseRequest(job_id=job.id, revision=1,
                replica_id=complete["details"]["result_replicas"]["model"], storage_id=storage_id), self.owner)
            # An explicit old retained Dataset copy can train a new model without advancing Dataset current_revision.
            request = self.model_request(dataset, storage_id=storage_id, launcher_id=launcher_id)
            self.assertEqual((await reserve_model(db, request, self.owner))["reserved_revision"], 1)

    async def test_operation_identity_token_scope_cancel_and_incomplete_archive(self):
        async with self.sessions() as db:
            dataset, model = await self.ready_model(db)
            request = OperationCreate(request_id=uuid4(), kind="backup", asset_id=model["id"], revision=1,
                source_replica_id=model["revisions"][0]["replicas"][0]["id"])
            response = await operations.create_operation(db, request, self.owner)
            self.assertEqual((await operations.create_operation(db, request, self.owner))["id"], response["id"])
            with self.assertRaises(HTTPException) as conflict:
                await operations.create_operation(db, request.model_copy(update={"include_dataset": True}), self.owner)
            self.assertEqual(conflict.exception.status_code, 409)
            with self.assertRaises(HTTPException) as scope:
                await operations.granted_operation(db, str(uuid4()), "Bearer " + response["grant"]["token"])
            self.assertEqual(scope.exception.status_code, 403)
            with self.assertRaises(HTTPException) as foreign:
                await operations.owned_operation(db, response["id"], self.other)
            self.assertEqual(foreign.exception.status_code, 404)
            operation = await db.get(Operation, response["id"])
            bad = {**model["revisions"][0]["artifact"], "manifest_sha256": "b" * 64}
            with self.assertRaises(HTTPException):
                await self.archive(db, operation, "model", bad)
            await operations.stop_operation(db, operation, cancel=True)
            with self.assertRaises(HTTPException) as cancelled:
                await operations.granted_operation(db, response["id"], "Bearer " + response["grant"]["token"])
            self.assertEqual(cancelled.exception.status_code, 410)
            self.assertEqual(len((await list_models(db, self.owner))["items"][0]["revisions"][0]["replicas"]), 1)

    async def test_registered_backup_survives_source_cleanup_and_dataset_delete_does_not_delete_model(self):
        async with self.sessions() as db:
            dataset, model = await self.ready_model(db)
            operation, _ = await self.backup(db, dataset, model, include_dataset=True)
            model_copy = await db.get(Replica, operation.details["result_replicas"]["model"])
            data_copy = await db.get(Replica, operation.details["result_replicas"]["dataset"])
            model_object_id, dataset_object_id = model_copy.object_id, data_copy.object_id
            await db.execute(update(StorageObject).where(StorageObject.id.in_([model_object_id, dataset_object_id])).values(
                experiment_id=None, updated_at=utcnow() - timedelta(days=3)))
            await db.commit()
            await cleanup_objects(db)
            self.assertIsNotNone(await db.get(StorageObject, model_object_id))
            self.assertIsNotNone(await db.get(StorageObject, dataset_object_id))
            with patch("storage.service.bucket_client") as client:
                deleted = await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="delete_replica",
                    asset_kind="dataset", asset_id=dataset["id"], revision=1, replica_id=data_copy.id), self.owner)
                self.assertTrue(client.return_value.delete_object.called)
            self.assertEqual(deleted["state"], "completed")
            self.assertIsNone(await db.get(StorageObject, dataset_object_id))
            self.assertIsNotNone(await db.get(StorageObject, model_object_id))
            self.assertEqual(model_copy.state, "present")

    async def test_exact_source_preview_counts_real_additions_changes_and_removals(self):
        async with self.sessions() as db:
            dataset = await freeze_dataset(db, self.selection(), self.owner)
            self.assertEqual(await preview_source(db, dataset["id"], self.selection(expected_revision=1), self.owner),
                {"added": 0, "changed": 0, "removed": 0})
            measurement = await db.get(Measurement, self.measurement_id)
            measurement.vars = {"width": 8}
            db.add(Measurement(user_id=self.owner, experiment_id=self.experiment_id, vars={"width": 3}, material_snapshot={}, recorded_at=utcnow()))
            await db.commit()
            self.assertEqual(await preview_source(db, dataset["id"], self.selection(expected_revision=1), self.owner),
                {"added": 1, "changed": 1, "removed": 0})

    async def test_storage_reattach_changes_execution_path_without_changing_model_identity(self):
        async with self.sessions() as db:
            _, model = await self.ready_model(db)
            launcher_id, _ = await self.second_storage(db)
            await register_storage(db, StorageRegistration(storage_id=self.storage_id, launcher_id=launcher_id, name="Same disk"), self.owner)
            artifact = model["revisions"][0]["artifact"]
            checked = await check_replica(db, ReplicaRegistration(asset_kind="model", asset_id=model["id"], revision=1,
                storage_id=self.storage_id, launcher_id=launcher_id, manifest_sha256=artifact["manifest_sha256"]), self.owner)
            self.assertEqual(checked["id"], model["revisions"][0]["replicas"][0]["id"])
            self.assertEqual((await list_models(db, self.owner))["items"][0]["id"], model["id"])

    async def test_expired_operation_becomes_interrupted_and_retry_reuses_verified_upload(self):
        async with self.sessions() as db:
            _, model = await self.ready_model(db)
            response = await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="backup",
                asset_id=model["id"], revision=1, source_replica_id=model["revisions"][0]["replicas"][0]["id"]), self.owner)
            operation = await db.get(Operation, response["id"])
            uploaded = await self.archive(db, operation, "model", model["revisions"][0]["artifact"])
            operation.expires_at = utcnow() - timedelta(seconds=1)
            await db.commit()
            await operations.expire_operation(db, operation)
            self.assertEqual(operation.state, "interrupted")
            await operations.issue_grant(db, operation, retry=True)
            done = await operations.complete_operation(db, operation, OperationComplete())
            self.assertEqual(done["state"], "completed")
            replica = await db.get(Replica, done["details"]["result_replicas"]["model"])
            self.assertEqual(replica.object_id, uploaded["reference"]["id"])

    async def test_internal_dataset_restore_preserves_model_and_dataset_current_revision(self):
        async with self.sessions() as db:
            dataset, model = await self.ready_model(db)
            backup, artifact = await self.backup(db, dataset, model, include_dataset=True)
            launcher_id, storage_id = await self.second_storage(db)
            response = await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="restore",
                asset_kind="dataset", asset_id=dataset["id"], revision=1,
                source_replica_id=backup.details["result_replicas"]["dataset"],
                target_storage_id=storage_id, target_launcher_id=launcher_id), self.owner)
            operation = await db.get(Operation, response["id"])
            with patch("storage.service.signed_parts", return_value=[]):
                manifest = await operations.transfer_manifest(db, operation)
            self.assertIn("dataset", manifest)
            self.assertNotIn("model", manifest)
            self.assertEqual(manifest["operation"]["dataset_id"], dataset["id"])
            completed = await operations.complete_operation(db, operation, OperationComplete(dataset=artifact))
            self.assertEqual(completed["state"], "completed")
            self.assertEqual(set(completed["details"]["result_replicas"]), {"dataset"})
            self.assertEqual(len((await list_models(db, self.owner))["items"][0]["revisions"]), 1)
            # Server revisions have no local manifest in their summary. The
            # registered restore copy supplies the checksum for later hello.
            revision = await db.get(DatasetRevision, (dataset["id"], 1))
            replay = await register_local_dataset(db, LocalDatasetRegistration(request_id=uuid4(),
                dataset_id=dataset["id"], revision=1, name=dataset["name"], experiment_id=self.experiment_id,
                source_hash="a" * 64, fingerprint=revision.fingerprint, manifest_sha256=artifact["manifest_sha256"],
                storage_id=storage_id, launcher_id=launcher_id, sample_count=1,
                source_contracts=revision.summary["source_contracts"], verified=False), self.owner)
            copy = next(item for item in replay["revisions"][0]["replicas"] if item["storage_id"] == storage_id)
            self.assertEqual(copy["state"], "present")
            self.assertEqual(copy["artifact"]["files"], artifact["files"])
            self.assertTrue(copy["artifact"]["retained"])

    async def test_busy_copy_deletion_waits_for_the_specific_execution_lease(self):
        async with self.sessions() as db:
            _, model = await self.ready_model(db)
            copy = model["revisions"][0]["replicas"][0]
            job = Job(id=str(uuid4()), user_id=self.owner, launcher_id=self.launcher_id, slave_app_id="predictor",
                handler_type="prediction.session", job_mode="webrtc", state="running")
            db.add(job)
            await db.commit()
            lease = ModelLeaseRequest(job_id=job.id, revision=1, replica_id=copy["id"])
            await lease_model(db, model["id"], lease, self.owner)
            response = await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="delete_replica",
                asset_id=model["id"], revision=1, replica_id=copy["id"]), self.owner)
            operation = await db.get(Operation, response["id"])
            self.assertEqual(response["stage"], "deleting")
            self.assertTrue((await operations.transfer_manifest(db, operation))["operation"]["replicas"][0]["blocked"])
            with self.assertRaises(HTTPException):
                await operations.complete_operation(db, operation, OperationComplete(replica_id=copy["id"]))
            await lease_model(db, model["id"], lease, self.owner, release=True)
            self.assertFalse((await operations.transfer_manifest(db, operation))["operation"]["replicas"][0]["blocked"])
            self.assertEqual((await operations.complete_operation(db, operation,
                OperationComplete(replica_id=copy["id"])))["state"], "completed")

    async def test_prepare_operation_and_metadata_only_registration_do_not_claim_file_verification(self):
        async with self.sessions() as db:
            dataset = await freeze_dataset(db, self.selection(), self.owner)
            request = self.model_request(dataset)
            model = await reserve_model(db, request, self.owner)
            operation = await db.get(Operation, str(request.request_id))
            self.assertEqual((operation.kind, operation.state), ("prepare", "pending"))
            completed = await complete_model(db, model["id"], 1,
                self.completion(request.request_id, verified=False), self.owner)
            replica = completed["revisions"][0]["replicas"][0]
            self.assertEqual(replica["state"], "unverified")
            self.assertIsNone(replica["verified_at"])
            self.assertEqual(operation.state, "completed")
            other = self.model_request(dataset)
            reserved = await reserve_model(db, other, self.owner)
            pending = await db.get(Operation, str(other.request_id))
            await operations.stop_operation(db, pending, cancel=True)
            with self.assertRaises(HTTPException) as cancelled:
                await complete_model(db, reserved["id"], 1, self.completion(other.request_id), self.owner)
            self.assertEqual(cancelled.exception.status_code, 410)

    async def test_pending_deletion_cannot_be_stolen_and_late_verification_cannot_revive_tombstone(self):
        async with self.sessions() as db:
            _, model = await self.ready_model(db)
            copy = model["revisions"][0]["replicas"][0]
            verified = await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="verify",
                asset_id=model["id"], revision=1, replica_id=copy["id"], target_launcher_id=self.launcher_id), self.owner)
            deletion = await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="delete_asset",
                asset_id=model["id"]), self.owner)
            with self.assertRaises(HTTPException):
                await operations.complete_operation(db, await db.get(Operation, verified["id"]),
                    OperationComplete(model=model["revisions"][0]["artifact"]))
            with self.assertRaises(HTTPException):
                await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="delete_replica",
                    asset_id=model["id"], revision=1, replica_id=copy["id"]), self.owner)
            operation = await db.get(Operation, deletion["id"])
            self.assertEqual((await db.get(Replica, copy["id"])).delete_id, operation.id)
            await operations.complete_operation(db, operation, OperationComplete(replica_id=copy["id"]))
            self.assertEqual((await list_models(db, self.owner))["items"], [])

    async def test_cancellation_during_bucket_verification_does_not_publish_a_copy(self):
        async with self.sessions() as db:
            _, model = await self.ready_model(db)
            response = await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="backup",
                asset_id=model["id"], revision=1, source_replica_id=model["revisions"][0]["replicas"][0]["id"]), self.owner)
            operation = await db.get(Operation, response["id"])
            checksum = hashlib.sha256(b"archive").hexdigest()
            with patch("storage.service.signed_parts", return_value=[]):
                await operations.prepare_archive(db, operation, "model", ArchiveUpload(
                    manifest={"encoding": "base64", "sha256": checksum, "byteLength": 7,
                        "chunks": [{"sha256": checksum, "byteLength": 7}]}, artifact=model["revisions"][0]["artifact"]))
            started, proceed = threading.Event(), threading.Event()
            def head(**_):
                started.set()
                if not proceed.wait(5):
                    raise TimeoutError("Cancellation did not release verification")
                return {"ContentLength": 7, "ChecksumSHA256": base64.b64encode(bytes.fromhex(checksum)).decode()}
            with patch("storage.service.bucket_client") as bucket:
                bucket.return_value.head_object.side_effect = head
                completing = asyncio.create_task(operations.complete_archive(db, operation, "model"))
                self.assertTrue(await asyncio.to_thread(started.wait, 5))
                async with self.sessions() as cancelling:
                    current = await operations.owned_operation(cancelling, response["id"], self.owner)
                    await operations.stop_operation(cancelling, current, cancel=True)
                proceed.set()
                with self.assertRaises(HTTPException) as cancelled:
                    await completing
                self.assertEqual(cancelled.exception.status_code, 410)
            self.assertEqual(len((await list_models(db, self.owner))["items"][0]["revisions"][0]["replicas"]), 1)

    async def test_operation_renewal_has_short_grace_and_fixed_absolute_deadline(self):
        async with self.sessions() as db:
            _, model = await self.ready_model(db)
            response = await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="backup",
                asset_id=model["id"], revision=1, source_replica_id=model["revisions"][0]["replicas"][0]["id"]), self.owner)
            claims = jwt.decode(response["grant"]["token"], settings.JWT_SECRET, algorithms=[settings.JWT_ALG])
            deadline = claims["renewal_exp"]
            claims.update(iat=int(time.time()) - 100, exp=int(time.time()) - 1)
            token = jwt.encode(claims, settings.JWT_SECRET, algorithm=settings.JWT_ALG)
            operation = await operations.granted_operation(db, response["id"], "Bearer " + token, renew=True)
            renewed = await operations.issue_grant(db, operation)
            self.assertEqual(jwt.decode(renewed["token"], settings.JWT_SECRET, algorithms=[settings.JWT_ALG])["renewal_exp"], deadline)
            claims["exp"] = int(time.time()) - 61
            token = jwt.encode(claims, settings.JWT_SECRET, algorithm=settings.JWT_ALG)
            with self.assertRaises(HTTPException) as stale:
                await operations.granted_operation(db, response["id"], "Bearer " + token, renew=True)
            self.assertEqual(stale.exception.status_code, 401)

    async def test_one_execution_cannot_silently_move_its_existing_copy_lease(self):
        async with self.sessions() as db:
            _, model = await self.ready_model(db)
            original = model["revisions"][0]["replicas"][0]
            _, storage_id = await self.second_storage(db)
            await register_storage(db, StorageRegistration(storage_id=storage_id,
                launcher_id=self.launcher_id, name="Second disk"), self.owner)
            other = await check_replica(db, ReplicaRegistration(asset_kind="model", asset_id=model["id"],
                revision=1, storage_id=storage_id, launcher_id=self.launcher_id,
                artifact=model["revisions"][0]["artifact"]), self.owner)
            job = Job(id=str(uuid4()), user_id=self.owner, launcher_id=self.launcher_id, slave_app_id="predictor",
                handler_type="prediction.session", job_mode="webrtc", state="running")
            db.add(job)
            await db.commit()
            request = ModelLeaseRequest(job_id=job.id, revision=1, replica_id=original["id"])
            await lease_model(db, model["id"], request, self.owner)
            with self.assertRaises(HTTPException) as conflict:
                await lease_model(db, model["id"], request.model_copy(update={"replica_id": other["id"]}), self.owner)
            self.assertEqual(conflict.exception.status_code, 409)
            self.assertEqual((await db.get(ModelLease, (model["id"], 1, job.id))).replica_id, original["id"])
            await lease_model(db, model["id"], request, self.owner, release=True)
            await lease_model(db, model["id"], request.model_copy(update={"replica_id": other["id"]}), self.owner)
            self.assertEqual((await db.get(ModelLease, (model["id"], 1, job.id))).replica_id, other["id"])

    async def test_deleted_copy_rejects_late_check_and_can_be_explicitly_restored(self):
        async with self.sessions() as db:
            dataset, model = await self.ready_model(db)
            backup, _ = await self.backup(db, dataset, model)
            original = model["revisions"][0]["replicas"][0]
            artifact = model["revisions"][0]["artifact"]
            verification = await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="verify",
                asset_id=model["id"], revision=1, replica_id=original["id"],
                target_launcher_id=self.launcher_id), self.owner)
            deletion = await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="delete_replica",
                asset_id=model["id"], revision=1, replica_id=original["id"]), self.owner)
            with self.assertRaises(HTTPException):
                await operations.complete_operation(db, await db.get(Operation, verification["id"]), OperationComplete(model=artifact))
            await operations.complete_operation(db, await db.get(Operation, deletion["id"]), OperationComplete(replica_id=original["id"]))
            with self.assertRaises(HTTPException) as deleted:
                await check_replica(db, ReplicaRegistration(asset_kind="model", asset_id=model["id"], revision=1,
                    storage_id=self.storage_id, launcher_id=self.launcher_id, artifact=artifact), self.owner)
            self.assertEqual(deleted.exception.status_code, 410)
            response = await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="restore",
                asset_id=model["id"], revision=1, source_replica_id=backup.details["result_replicas"]["model"],
                target_storage_id=self.storage_id, target_launcher_id=self.launcher_id), self.owner)
            restored = await operations.complete_operation(db, await db.get(Operation, response["id"]), OperationComplete(model=artifact))
            self.assertEqual(restored["details"]["result_replicas"]["model"], original["id"])
            self.assertEqual((await db.get(Replica, original["id"])).state, "present")

    async def test_cancelled_restore_cannot_register_its_local_dataset_through_later_hello(self):
        async with self.sessions() as db:
            body = LocalDatasetRegistration(request_id=uuid4(), dataset_id=uuid4(), revision=1,
                name="Local data", experiment_id=self.experiment_id, source_hash="a" * 64,
                fingerprint="sha256:" + "d" * 64, manifest_sha256="d" * 64,
                storage_id=self.storage_id, launcher_id=self.launcher_id, sample_count=1,
                source_contracts={"experimentId": self.experiment_id, "sourceHash": "a" * 64,
                    "records": [{"id": self.record_id}], "calculations": [], "varsSchema": {}})
            dataset = await register_local_dataset(db, body, self.owner)
            request = self.model_request(dataset)
            model = await reserve_model(db, request, self.owner)
            model = await complete_model(db, model["id"], 1, self.completion(request.request_id), self.owner)
            backup, _ = await self.backup(db, dataset, model, include_dataset=True)
            launcher_id, storage_id = await self.second_storage(db)
            response = await operations.create_operation(db, OperationCreate(request_id=uuid4(), kind="restore",
                asset_id=model["id"], revision=1, source_replica_id=backup.details["result_replicas"]["model"],
                target_storage_id=storage_id, target_launcher_id=launcher_id, include_dataset=True,
                dataset_source_replica_id=backup.details["result_replicas"]["dataset"]), self.owner)
            await operations.stop_operation(db, await db.get(Operation, response["id"]), cancel=True)
            replay = body.model_copy(update={"storage_id": storage_id, "launcher_id": launcher_id, "verified": False})
            with self.assertRaises(HTTPException) as denied:
                await register_local_dataset(db, replay, self.owner)
            self.assertEqual(denied.exception.status_code, 409)
            with self.assertRaises(HTTPException):
                await check_replica(db, ReplicaRegistration(asset_kind="dataset", asset_id=dataset["id"], revision=1,
                    storage_id=storage_id, launcher_id=launcher_id, manifest_sha256=body.manifest_sha256), self.owner)
            self.assertIsNone(await db.scalar(select(Replica).where(Replica.dataset_id == dataset["id"], Replica.storage_id == storage_id)))
            update = replay.model_copy(update={"request_id": uuid4(), "revision": 2, "expected_revision": 1,
                "fingerprint": "sha256:" + "e" * 64, "manifest_sha256": "e" * 64})
            with self.assertRaises(HTTPException):
                await register_local_dataset(db, update, self.owner)
            synced = await register_local_dataset(db, update.model_copy(update={"storage_id": self.storage_id,
                "launcher_id": self.launcher_id}), self.owner)
            self.assertEqual(synced["current_revision"], 2)
