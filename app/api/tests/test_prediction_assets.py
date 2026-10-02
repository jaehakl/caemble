"""Small real PostgreSQL lifecycle tests; no Solver or production database."""
import asyncio
import hashlib
import os
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError
import jwt
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from db import make_async_db_url
from gpstation.db import Job, Launcher
from gpstation.service.state import utcnow
from prediction.common import canonical_bytes
from prediction.datasets import content_identity, freeze_dataset, register_local_dataset
from prediction.db import Dataset, DatasetGrant, DatasetObject, DatasetRevision, ModelRevision, PredictionModel
from prediction.grants import create_grant, read_granted_object, read_granted_revision, release_grant, renew_grant
from prediction.lifecycle import delete_asset, register_storage
from prediction.models import complete_model, lease_model, reserve_model, list_models
from prediction.schemas import DatasetSelection, DeleteRequest, LocalDatasetRegistration, ModelComplete, ModelLeaseRequest, ModelReserve, StorageRegistration
from settings import settings
from simulation.db import Experiment, ExperimentNamespace, ExperimentRecord, Measurement, RecordedData
from storage.db import StorageObject
from storage.service import cleanup_objects, reference
from test_calculation_database import _check, _create_database, _database_url, _drop_database, _upgrade
from user_auth.db import User


class PredictionIdentityTests(unittest.TestCase):
    def test_new_model_and_dataset_contracts_reject_inverse_training(self):
        with self.assertRaises(ValidationError):
            ModelReserve(request_id=uuid4(), name="Retired", direction="inverse", dataset_id=uuid4(),
                dataset_revision=1, definition={}, storage_id=uuid4(), launcher_id=uuid4())
        with self.assertRaises(ValidationError):
            DatasetSelection(request_id=uuid4(), name="Forward", experiment_id=1, source_hash="a" * 64,
                vars_schema={}, record_ids=[1], calculation_ids=[2])

    def test_content_identity_ignores_location_but_preserves_meaning(self):
        first = {"kind": "caemble.object", "version": 1, "id": str(uuid4()), "sha256": "a" * 64,
            "encoding": "json", "byteLength": 3, "length": 1}
        moved = {**first, "id": str(uuid4())}
        self.assertEqual(content_identity(first), content_identity(moved))
        self.assertNotEqual(content_identity(first), content_identity({**moved, "sha256": "b" * 64}))


class RetiredPredictionGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_retired_ready_receipt_replays_but_unfinished_publication_is_rejected(self):
        request_id = uuid4()
        body = ModelComplete(request_id=request_id, manifest_sha256="a" * 64,
            files=[{"name": "model.json", "sha256": "b" * 64, "byteLength": 3}],
            profile={}, input_layouts=[], output_layouts=[])
        artifact = body.model_dump(mode="json", exclude={"request_id", "verified"}, exclude_none=True)
        model = SimpleNamespace(id=str(uuid4()), direction="inverse")
        revision = SimpleNamespace(request_id=str(request_id), state="ready", artifact=artifact)
        db = SimpleNamespace(get=AsyncMock(return_value=revision), commit=AsyncMock())
        response = {"id": model.id, "support_status": "retired"}
        with patch("prediction.models.owned", AsyncMock(return_value=model)), \
                patch("prediction.models.model_view", AsyncMock(return_value=response)):
            self.assertEqual(await complete_model(db, model.id, 1, body, "owner"), response)
            revision.state = "reserved"
            with self.assertRaises(HTTPException) as error:
                await complete_model(db, model.id, 1, body, "owner")
            self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(revision.artifact, artifact)
        db.commit.assert_not_awaited()

    async def test_retired_lease_can_release_but_cannot_load(self):
        from prediction.db import ModelLease
        model = SimpleNamespace(id=str(uuid4()), direction="inverse")
        body = ModelLeaseRequest(job_id=uuid4(), revision=1)
        db = SimpleNamespace(get=AsyncMock(return_value=None), commit=AsyncMock(), delete=AsyncMock())
        with patch("prediction.models.owned", AsyncMock(return_value=model)):
            with self.assertRaises(HTTPException) as error:
                await lease_model(db, model.id, body, "owner")
            self.assertEqual(error.exception.status_code, 409)
            self.assertEqual(await lease_model(db, model.id, body, "owner", release=True), {"released": True})
        db.get.assert_called_with(ModelLease, (model.id, 1, str(body.job_id)))
        db.delete.assert_not_awaited()

    async def test_retired_prepare_retry_is_rejected_before_changing_operation(self):
        from prediction.operations import issue_grant
        operation = SimpleNamespace(kind="prepare", state="interrupted", stage="preparing", asset_id=str(uuid4()))
        db = SimpleNamespace(get=AsyncMock(return_value=SimpleNamespace(direction="inverse")), commit=AsyncMock())
        with self.assertRaises(HTTPException) as error:
            await issue_grant(db, operation, retry=True)
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(operation.state, "interrupted")
        db.commit.assert_not_awaited()


class LocalForwardDatasetTests(unittest.IsolatedAsyncioTestCase):
    async def test_registration_preserves_legacy_calculation_metadata_without_requiring_live_calculations(self):
        contracts = {"experimentId": 3, "sourceHash": "a" * 64,
            "records": [{"id": 5}], "calculations": [{"id": 9001, "source_hash": "retired-source"}]}
        body = LocalDatasetRegistration(request_id=uuid4(), dataset_id=uuid4(), revision=1,
            name="Legacy data", experiment_id=3, source_hash="a" * 64,
            fingerprint="sha256:" + "d" * 64, manifest_sha256="d" * 64,
            storage_id=uuid4(), launcher_id=uuid4(), sample_count=1, source_contracts=contracts)
        db = SimpleNamespace(get=AsyncMock(return_value=None), add=Mock(), flush=AsyncMock(),
            scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: [5])),
            execute=AsyncMock(), commit=AsyncMock())
        with patch("prediction.datasets.connected_storage", AsyncMock()), \
                patch("prediction.datasets.lock_identity", AsyncMock()), \
                patch("prediction.datasets.source_experiment", AsyncMock()), \
                patch("prediction.replicas.put_replica", AsyncMock()) as put_replica, \
                patch("prediction.datasets.dataset_view", AsyncMock(return_value={"id": str(body.dataset_id)})):
            await register_local_dataset(db, body, "owner")
        db.scalars.assert_awaited_once()
        revision = next(call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], DatasetRevision))
        self.assertEqual(revision.payload, {"sourceContracts": contracts})
        self.assertEqual(revision.summary["source_contracts"], contracts)
        self.assertEqual(revision.summary["manifest_sha256"], body.manifest_sha256)
        self.assertEqual(revision.fingerprint, body.fingerprint)
        self.assertEqual(put_replica.await_args.kwargs["artifact"],
            {"manifest_sha256": body.manifest_sha256, "fingerprint": body.fingerprint})


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class PredictionAssetsTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = f"caemble_calculation_test_{uuid4().hex}"
        asyncio.run(_create_database(cls.database))
        try:
            _upgrade(cls.database, "head")
            _check(cls.database)
        except BaseException:
            asyncio.run(_drop_database(cls.database))
            raise

    @classmethod
    def tearDownClass(cls):
        asyncio.run(_drop_database(cls.database))

    async def asyncSetUp(self):
        self.engine = create_async_engine(make_async_db_url(_database_url(self.database)))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False, autoflush=False)
        self.owner, self.other, self.launcher_id, self.storage_id = (str(uuid4()) for _ in range(4))
        self.signing = patch.object(settings, "JWT_SECRET", "prediction-disposable-test-secret")
        self.signing.start()
        async with self.sessions() as db:
            db.add_all([User(id=self.owner, is_active=True), User(id=self.other, is_active=True)])
            await db.flush()
            namespace = "prediction-" + uuid4().hex
            db.add(ExperimentNamespace(namespace=namespace, user_id=self.owner))
            await db.flush()
            experiment = Experiment(user_id=self.owner, namespace=namespace, repository_slug="fixture", experiment_key="knn",
                version_major=1, version_minor=0, version_patch=0, name="Prediction fixture",
                source_bundle={"files": {"experiment.tsx": "fixture"}}, source_hash="a" * 64, result_contracts={})
            db.add(experiment)
            await db.flush()
            self.experiment_id = experiment.id
            record = ExperimentRecord(experiment_id=experiment.id, name="temperature", quantity_kind="Temperature",
                tensor_order=0, dtype="float64", data_schema={"dtype": "float64"}, contract_hash="b" * 64)
            measurement = Measurement(user_id=self.owner, experiment_id=experiment.id, vars={"width": 2},
                material_snapshot={}, recorded_at=utcnow())
            db.add_all([record, measurement])
            await db.flush()
            self.record_id, self.measurement_id = record.id, measurement.id
            raw = b"[3,4]"
            checksum = hashlib.sha256(raw).hexdigest()
            stored = StorageObject(id=str(uuid4()), user_id=self.owner, experiment_id=experiment.id,
                measurement_id=measurement.id, purpose="record", ready=True, bound=True, deleting=False,
                manifest={"encoding": "json", "sha256": checksum, "byteLength": len(raw), "length": 2,
                    "chunks": [{"sha256": checksum, "byteLength": len(raw)}]})
            db.add(stored)
            await db.flush()
            self.object_id, self.ref = stored.id, reference(stored)
            db.add(RecordedData(user_id=self.owner, measurement_id=measurement.id, experiment_record_id=record.id,
                data={"shape": [2], "storage": {"kind": "inline", "value": self.ref}}))
            db.add(Launcher(id=self.launcher_id, user_id=self.owner, installation_id=str(uuid4()), launcher_name="fixture",
                status="ready", connected_at=utcnow(), last_heartbeat_at=utcnow(), slave_app_ids=["predictor"]))
            await db.commit()
            await register_storage(db, StorageRegistration(storage_id=self.storage_id, launcher_id=self.launcher_id, name="fixture"), self.owner)

    async def asyncTearDown(self):
        self.signing.stop()
        await self.engine.dispose()

    def selection(self, **changes):
        return DatasetSelection(**{"request_id": str(uuid4()), "name": "Training data", "experiment_id": self.experiment_id,
            "source_hash": "a" * 64, "vars_schema": {"width": {"shape": [], "min": 0, "max": 10}},
            "record_ids": [self.record_id], **changes})

    def model_request(self, dataset, **changes):
        return ModelReserve(**{"request_id": str(uuid4()), "name": "Forward model", "direction": "forward",
            "dataset_id": dataset["id"], "dataset_revision": dataset["current_revision"],
            "definition": {"algorithm": {"kind": "knn"}, "implementationVersion": "knn-v1",
                "preprocessingVersion": "box-relative-v2"}, "storage_id": self.storage_id,
            "launcher_id": self.launcher_id, **changes})

    def completion(self, operation_id, **changes):
        return ModelComplete(**{"request_id": operation_id, "manifest_sha256": "f" * 64,
            "files": [{"name": "samples.bin", "sha256": "e" * 64, "byteLength": 16}],
            "profile": {"rowCount": 1}, "input_layouts": [], "output_layouts": [], **changes})

    async def test_snapshot_survives_source_deletion_and_scoped_downloads(self):
        async with self.sessions() as db:
            request = self.selection()
            dataset = await freeze_dataset(db, request, self.owner)
            replay = await freeze_dataset(db, request, self.owner)
            self.assertEqual(dataset["id"], replay["id"])
            await db.execute(delete(Measurement).where(Measurement.id == self.measurement_id))
            await db.commit()
            grant = await create_grant(db, dataset["id"], 1, self.owner)
            authorization = "Bearer " + grant["token"]
            item = await read_granted_revision(db, dataset["id"], 1, authorization)
            self.assertEqual(item.payload["measurements"][0]["vars"], {"width": 2})
            self.assertEqual(hashlib.sha256(canonical_bytes(item.payload)).hexdigest(), grant["manifest_sha256"])
            with patch("storage.service.signed_parts", return_value=[{"url": "https://fixture.invalid"}]):
                ticket = await read_granted_object(db, dataset["id"], 1, self.object_id, authorization)
            self.assertEqual(ticket["reference"], self.ref)
            with self.assertRaises(HTTPException) as denied:
                await read_granted_object(db, dataset["id"], 1, str(uuid4()), authorization)
            self.assertEqual(denied.exception.status_code, 403)
            await db.execute(update(StorageObject).where(StorageObject.id == self.object_id).values(updated_at=utcnow() - timedelta(days=3)))
            await db.commit()
            await cleanup_objects(db)
            self.assertFalse((await db.get(StorageObject, self.object_id)).deleting)
            with self.assertRaises(HTTPException) as denied:
                await create_grant(db, dataset["id"], 1, self.other)
            self.assertEqual(denied.exception.status_code, 404)

    async def test_sync_retires_only_payload_and_waits_for_grants(self):
        async with self.sessions() as db:
            dataset = await freeze_dataset(db, self.selection(), self.owner)
            model = await reserve_model(db, self.model_request(dataset), self.owner)
            await complete_model(db, model["id"], 1, self.completion(model["operation_id"]), self.owner)
            grant = await create_grant(db, dataset["id"], 1, self.owner)
            await db.execute(delete(Measurement).where(Measurement.id == self.measurement_id))
            await db.commit()
            sync = self.selection(expected_revision=1)
            with self.assertRaises(HTTPException) as busy:
                await freeze_dataset(db, sync, self.owner, dataset["id"])
            self.assertEqual(busy.exception.status_code, 409)
            await release_grant(db, dataset["id"], grant["grant_id"], self.owner)
            changed = await freeze_dataset(db, sync, self.owner, dataset["id"])
            self.assertEqual(changed["current_revision"], 2)
            self.assertEqual(changed["revisions"][0]["sample_count"], 0)
            self.assertIsNone((await db.get(DatasetRevision, (dataset["id"], 1))).payload)
            self.assertEqual((await db.get(ModelRevision, (model["id"], 1))).dataset_revision, 1)
            self.assertIsNone(await db.scalar(select(DatasetObject).where(DatasetObject.dataset_id == dataset["id"])))
            deleted = await delete_asset(db, "dataset", dataset["id"], DeleteRequest(request_id=uuid4()), self.owner)
            self.assertEqual(deleted["state"], "deleted")
            self.assertEqual((await db.get(PredictionModel, model["id"])).state, "active")
            self.assertEqual((await db.get(ModelRevision, (model["id"], 1))).source_contracts["sourceHash"], "a" * 64)

    async def test_model_retry_tombstone_and_offline_deletion_stays_pending(self):
        async with self.sessions() as db:
            dataset = await freeze_dataset(db, self.selection(), self.owner)
            request = self.model_request(dataset)
            model = await reserve_model(db, request, self.owner)
            self.assertEqual((await reserve_model(db, request, self.owner))["reserved_revision"], 1)
            completed = await complete_model(db, model["id"], 1, self.completion(request.request_id), self.owner)
            self.assertEqual(completed["current_revision"], 1)
            await complete_model(db, model["id"], 1, self.completion(request.request_id), self.owner)
            with self.assertRaises(HTTPException) as changed:
                await complete_model(db, model["id"], 1, self.completion(request.request_id, manifest_sha256="c" * 64), self.owner)
            self.assertEqual(changed.exception.status_code, 409)
            removal = DeleteRequest(request_id=uuid4(), storage_id=self.storage_id, launcher_id=self.launcher_id)
            launcher = await db.get(Launcher, self.launcher_id)
            launcher.disconnected_at = utcnow()
            await db.commit()
            pending = await delete_asset(db, "model", model["id"], removal, self.owner)
            self.assertEqual(pending["state"], "deleting")
            self.assertEqual(pending["revisions"][0]["replicas"][0]["state"], "deleting")
            launcher.disconnected_at = None
            await db.commit()
            self.assertEqual((await delete_asset(db, "model", model["id"], removal, self.owner))["state"], "deleting")
            with self.assertRaises(HTTPException) as revived:
                await complete_model(db, model["id"], 1, self.completion(request.request_id), self.owner)
            self.assertEqual(revived.exception.status_code, 410)
            await delete_asset(db, "model", model["id"], removal, self.owner, complete=True)
            await delete_asset(db, "model", model["id"], removal, self.owner, complete=True)
            with self.assertRaises(HTTPException) as revived:
                await reserve_model(db, request, self.owner)
            self.assertEqual(revived.exception.status_code, 410)

    async def test_expired_released_and_wrong_revision_grants_fail(self):
        async with self.sessions() as db:
            dataset = await freeze_dataset(db, self.selection(), self.owner)
            grant = await create_grant(db, dataset["id"], 1, self.owner)
            with self.assertRaises(HTTPException) as wrong:
                await read_granted_revision(db, dataset["id"], 2, "Bearer " + grant["token"])
            self.assertEqual(wrong.exception.status_code, 403)
            claims = jwt.decode(grant["token"], settings.JWT_SECRET, algorithms=[settings.JWT_ALG])
            expired = jwt.encode({**claims, "exp": time.time() - 10}, settings.JWT_SECRET, algorithm=settings.JWT_ALG)
            with self.assertRaises(HTTPException) as expired_error:
                await read_granted_revision(db, dataset["id"], 1, "Bearer " + expired)
            self.assertEqual(expired_error.exception.status_code, 401)
            await release_grant(db, dataset["id"], grant["grant_id"], self.owner)
            with self.assertRaises(HTTPException) as released:
                await read_granted_revision(db, dataset["id"], 1, "Bearer " + grant["token"])
            self.assertEqual(released.exception.status_code, 410)

    async def test_grant_renewal_keeps_scope_and_honors_release(self):
        async with self.sessions() as db:
            dataset = await freeze_dataset(db, self.selection(), self.owner)
            grant = await create_grant(db, dataset["id"], 1, self.owner)
            authorization = "Bearer " + grant["token"]
            claims = jwt.decode(grant["token"], settings.JWT_SECRET, algorithms=[settings.JWT_ALG])
            with patch("prediction.grants.time.time", return_value=claims["iat"] + 10):
                renewed = await renew_grant(db, dataset["id"], 1, authorization)
            self.assertEqual(renewed["expires_at"], grant["expires_at"] + 10)
            self.assertEqual({key: value for key, value in grant.items() if key not in {"token", "expires_at"}},
                {key: value for key, value in renewed.items() if key not in {"token", "expires_at"}})
            with self.assertRaises(HTTPException) as wrong_revision:
                await renew_grant(db, dataset["id"], 2, authorization)
            self.assertEqual(wrong_revision.exception.status_code, 403)
            for replacement in ({"sub": self.other}, {"fingerprint": "sha256:" + "c" * 64}):
                wrong = jwt.encode({**claims, **replacement}, settings.JWT_SECRET, algorithm=settings.JWT_ALG)
                with self.assertRaises(HTTPException) as wrong_scope:
                    await renew_grant(db, dataset["id"], 1, "Bearer " + wrong)
                self.assertEqual(wrong_scope.exception.status_code, 410)
            await release_grant(db, dataset["id"], grant["grant_id"], self.owner)
            with self.assertRaises(HTTPException) as released:
                await renew_grant(db, dataset["id"], 1, "Bearer " + renewed["token"])
            self.assertEqual(released.exception.status_code, 410)

    async def test_grant_renewal_has_short_expiry_grace_and_absolute_deadline(self):
        async with self.sessions() as db:
            dataset = await freeze_dataset(db, self.selection(), self.owner)
            grant = await create_grant(db, dataset["id"], 1, self.owner)
            now = int(time.time())
            claims = jwt.decode(grant["token"], settings.JWT_SECRET, algorithms=[settings.JWT_ALG])
            claims.update(iat=now - 906, exp=now - 6, renewal_exp=now + 894)
            lease = await db.get(DatasetGrant, grant["grant_id"])
            lease.expires_at = datetime.fromtimestamp(claims["exp"], timezone.utc)
            await db.commit()
            token = jwt.encode(claims, settings.JWT_SECRET, algorithm=settings.JWT_ALG)
            renewed = await renew_grant(db, dataset["id"], 1, "Bearer " + token)
            self.assertEqual(renewed["expires_at"], claims["renewal_exp"])
            for expired in ({**claims, "exp": now - 61},
                    {**claims, "iat": now - 1801, "renewal_exp": now - 1}):
                token = jwt.encode(expired, settings.JWT_SECRET, algorithm=settings.JWT_ALG)
                with self.assertRaises(HTTPException) as timeout:
                    await renew_grant(db, dataset["id"], 1, "Bearer " + token)
                self.assertEqual(timeout.exception.status_code, 401)

    async def test_grant_renewal_cannot_revive_retired_or_deleted_payload(self):
        async with self.sessions() as db:
            dataset = await freeze_dataset(db, self.selection(), self.owner)
            grant = await create_grant(db, dataset["id"], 1, self.owner)
            lease = await db.get(DatasetGrant, grant["grant_id"])
            lease.expires_at = utcnow() - timedelta(seconds=61)
            await db.execute(delete(Measurement).where(Measurement.id == self.measurement_id))
            await db.commit()
            await freeze_dataset(db, self.selection(expected_revision=1), self.owner, dataset["id"])
            with self.assertRaises(HTTPException) as retired:
                await renew_grant(db, dataset["id"], 1, "Bearer " + grant["token"])
            self.assertEqual(retired.exception.status_code, 410)
            latest = await create_grant(db, dataset["id"], 2, self.owner)
            lease = await db.get(DatasetGrant, latest["grant_id"])
            lease.expires_at = utcnow() - timedelta(seconds=61)
            await db.commit()
            await delete_asset(db, "dataset", dataset["id"], DeleteRequest(request_id=uuid4()), self.owner)
            with self.assertRaises(HTTPException) as deleted:
                await renew_grant(db, dataset["id"], 2, "Bearer " + latest["token"])
            self.assertEqual(deleted.exception.status_code, 410)

    async def test_unchanged_sync_receipt_does_not_later_absorb_new_data(self):
        async with self.sessions() as db:
            dataset = await freeze_dataset(db, self.selection(), self.owner)
            noop = self.selection(expected_revision=1)
            self.assertEqual((await freeze_dataset(db, noop, self.owner, dataset["id"]))["current_revision"], 1)
            await db.execute(delete(Measurement).where(Measurement.id == self.measurement_id))
            await db.commit()
            self.assertEqual((await freeze_dataset(db, noop, self.owner, dataset["id"]))["current_revision"], 1)
            self.assertEqual((await db.get(DatasetRevision, (dataset["id"], 1))).summary["sample_count"], 1)

    async def test_explicit_model_update_supersedes_pending_completion(self):
        async with self.sessions() as db:
            dataset = await freeze_dataset(db, self.selection(), self.owner)
            first_request = self.model_request(dataset)
            first = await reserve_model(db, first_request, self.owner)
            next_request = self.model_request(dataset, model_id=first["id"], expected_revision=0)
            second = await reserve_model(db, next_request, self.owner)
            self.assertEqual(second["reserved_revision"], 2)
            with self.assertRaises(HTTPException) as stale:
                await complete_model(db, first["id"], 1, self.completion(first_request.request_id), self.owner)
            self.assertEqual(stale.exception.status_code, 410)
            finished = await complete_model(db, first["id"], 2, self.completion(next_request.request_id), self.owner)
            self.assertEqual(finished["current_revision"], 2)
            with self.assertRaises(ValidationError):
                self.model_request(dataset, direction="inverse")

    async def test_legacy_inverse_remains_listed_and_reconciles_ready_receipt_without_launching(self):
        async with self.sessions() as db:
            dataset = await freeze_dataset(db, self.selection(), self.owner)
            request = self.model_request(dataset)
            model = await reserve_model(db, request, self.owner)
            completion = self.completion(request.request_id)
            finished = await complete_model(db, model["id"], 1, completion, self.owner)
            stored = await db.get(PredictionModel, model["id"])
            stored.direction = "inverse"  # Seed a pre-retirement asset without an active Inverse creation API.
            await db.commit()
            replay = await complete_model(db, stored.id, 1, completion, self.owner)
            self.assertEqual(replay["support_status"], "retired")
            self.assertEqual(replay["revisions"], [{**item, "support_status": "retired"} for item in finished["revisions"]])
            self.assertEqual((await list_models(db, self.owner))["items"][0]["id"], stored.id)
            with self.assertRaises(HTTPException) as denied:
                await reserve_model(db, self.model_request(dataset, model_id=stored.id, expected_revision=1), self.owner)
            self.assertEqual(denied.exception.status_code, 409)

    async def test_concurrent_creation_reuses_one_revision(self):
        request = self.selection()
        async def create():
            async with self.sessions() as db:
                return await freeze_dataset(db, request, self.owner)
        first, second = await asyncio.gather(create(), create())
        self.assertEqual(first["id"], second["id"])
        self.assertEqual([item["revision"] for item in second["revisions"]], [1])

    async def test_concurrent_storage_hello_reconciles_one_identity(self):
        request = StorageRegistration(storage_id=uuid4(), launcher_id=self.launcher_id, name="Shared storage")
        async def register():
            async with self.sessions() as db:
                return await register_storage(db, request, self.owner)
        first, second = await asyncio.gather(register(), register())
        self.assertEqual(first["storage_id"], second["storage_id"])
        self.assertEqual(first["launcher_id"], second["launcher_id"])

    async def test_crashed_model_lease_blocks_delete_until_execution_cleanup(self):
        async with self.sessions() as db:
            dataset = await freeze_dataset(db, self.selection(), self.owner)
            model = await reserve_model(db, self.model_request(dataset), self.owner)
            job = Job(id=str(uuid4()), user_id=self.owner, launcher_id=self.launcher_id,
                slave_app_id="predictor", handler_type="prediction.session", job_mode="webrtc", state="running")
            db.add(job)
            await db.commit()
            lease = ModelLeaseRequest(job_id=job.id, revision=1)
            await lease_model(db, model["id"], lease, self.owner)
            removal = DeleteRequest(request_id=uuid4(), storage_id=self.storage_id, launcher_id=self.launcher_id)
            for state, cleaned_at in (("running", None), ("cancelled", None)):
                job.state, job.cleaned_at = state, cleaned_at
                await db.commit()
                with self.assertRaises(HTTPException) as busy:
                    await delete_asset(db, "model", model["id"], removal, self.owner)
                self.assertEqual(busy.exception.status_code, 409)
            job.cleaned_at = utcnow()
            await db.commit()
            self.assertEqual((await delete_asset(db, "model", model["id"], removal, self.owner))["state"], "deleting")
            await lease_model(db, model["id"], lease, self.owner, release=True)

    async def test_local_dataset_reconciles_by_revision_and_never_revives_after_delete(self):
        async with self.sessions() as db:
            body = LocalDatasetRegistration(request_id=uuid4(), dataset_id=uuid4(), revision=1,
                name="Local data", experiment_id=self.experiment_id, source_hash="a" * 64,
                fingerprint="sha256:" + "d" * 64, manifest_sha256="d" * 64,
                storage_id=self.storage_id, launcher_id=self.launcher_id, sample_count=1,
                source_contracts={"experimentId": self.experiment_id, "sourceHash": "a" * 64,
                    "records": [{"id": self.record_id}], "calculations": [], "varsSchema": {}})
            local = await register_local_dataset(db, body, self.owner)
            retry = body.model_copy(update={"request_id": uuid4()})
            self.assertEqual((await register_local_dataset(db, retry, self.owner))["id"], local["id"])
            with self.assertRaises(HTTPException) as changed:
                await register_local_dataset(db, retry.model_copy(update={"manifest_sha256": "e" * 64}), self.owner)
            self.assertEqual(changed.exception.status_code, 409)
            await db.execute(delete(ExperimentRecord).where(ExperimentRecord.id == self.record_id))
            await db.commit()
            self.assertEqual((await register_local_dataset(db, retry, self.owner))["current_revision"], 1)
            removal = DeleteRequest(request_id=uuid4(), storage_id=self.storage_id, launcher_id=self.launcher_id)
            await delete_asset(db, "dataset", local["id"], removal, self.owner)
            with self.assertRaises(HTTPException) as revived:
                await register_local_dataset(db, retry, self.owner)
            self.assertEqual(revived.exception.status_code, 410)

    async def test_released_model_lease_allows_delete_while_execution_remains_open(self):
        async with self.sessions() as db:
            dataset = await freeze_dataset(db, self.selection(), self.owner)
            model = await reserve_model(db, self.model_request(dataset), self.owner)
            job = Job(id=str(uuid4()), user_id=self.owner, launcher_id=self.launcher_id,
                slave_app_id="predictor", handler_type="prediction.session", job_mode="webrtc", state="running")
            db.add(job)
            await db.commit()
            lease = ModelLeaseRequest(job_id=job.id, revision=1)
            await lease_model(db, model["id"], lease, self.owner)
            await lease_model(db, model["id"], lease, self.owner)
            # An acknowledged prepare/load failure owns no instance, so the UI
            # releases this lease without cancelling its reusable execution.
            await lease_model(db, model["id"], lease, self.owner, release=True)
            await lease_model(db, model["id"], lease, self.owner, release=True)
            removal = DeleteRequest(request_id=uuid4(), storage_id=self.storage_id, launcher_id=self.launcher_id)
            self.assertEqual((await delete_asset(db, "model", model["id"], removal, self.owner))["state"], "deleting")
            with self.assertRaises(HTTPException) as resurrected:
                await lease_model(db, model["id"], lease, self.owner)
            self.assertEqual(resurrected.exception.status_code, 410)

    async def test_model_lease_rejects_unowned_or_non_predictor_execution(self):
        async with self.sessions() as db:
            dataset = await freeze_dataset(db, self.selection(), self.owner)
            model = await reserve_model(db, self.model_request(dataset), self.owner)
            for owner, slave in ((self.other, "predictor"), (self.owner, "cae")):
                job = Job(id=str(uuid4()), user_id=owner, launcher_id=self.launcher_id,
                    slave_app_id=slave, handler_type="prediction.session", job_mode="webrtc", state="running")
                db.add(job)
                await db.commit()
                with self.assertRaises(HTTPException) as rejected:
                    await lease_model(db, model["id"], ModelLeaseRequest(job_id=job.id, revision=1), self.owner)
                self.assertEqual(rejected.exception.status_code, 409)
