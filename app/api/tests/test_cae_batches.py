"""Durable CAE lifecycle checks against disposable PostgreSQL databases."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from alembic import command
from alembic.config import Config
from caemble_catalog import Catalog
from fastapi import HTTPException
from sqlalchemy import delete, func, null, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from test_calculation_database import (
    API_DIR, ORIGINAL_DB_URL, _check, _create_database, _database_url, _drop_database,
    _seed_owners, _table_names, _upgrade,
)
from cae.batches import (
    cancel_batch, create_batch, list_batches, require_batch,
    mark_batch_read, require_no_active_batches, retry_batch,
)
from cae.db import CaeBatch
from cae.events import stream_events
from cae.models import BatchCreateRequest
from cae.uploads import CHUNK_BYTES, commit_batch, expire_uploads, finalize_item, measurement_artifact_info, upload_chunk
from cae.db import CaeUploadChunk
from cae.recording import complete_job, stage_record
from db import Experiment, ExperimentRecord, Measurement, RecordedData, make_async_db_url
from gpstation.db import Job, JobBatch, JobEvent, JobRecord, Launcher
from gpstation.service.batches import add_event, fail_server_jobs, finish_job, serialize_events
from gpstation.service.job_service import JobService
from gpstation.service.state import utcnow
from gpstation.service.worker_connection import worker_cleaned
from models import RoleEnum, UserData
from service.measurement_service import delete_measurements
from service.material_snapshot import material_vars_hash
from settings import settings


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class CaeBatchDatabaseTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        asyncio.run(_create_database(cls.database))
        try:
            _upgrade(cls.database, "head")
            cls.owner_id, cls.other_id, cls.experiment_id, cls.other_experiment_id = asyncio.run(_seed_owners(cls.database))
            cls.catalog = Catalog.open_readonly()
            entry = next(row for row in cls.catalog.list_experiments(limit=10000)[0] if row["key"] == "electro-thermal-notched-bar")
            cls.example = cls.catalog.experiment(entry["coordinate"])
        except BaseException:
            asyncio.run(_drop_database(cls.database))
            raise

    @classmethod
    def tearDownClass(cls):
        cls.catalog.close()
        asyncio.run(_drop_database(cls.database))

    async def asyncSetUp(self):
        self.engine = create_async_engine(make_async_db_url(_database_url(self.database)))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.owner = UserData(id=self.owner_id, roles=[RoleEnum.user])
        async with self.sessions() as db:
            for model in (Measurement, JobBatch, Job, Launcher, ExperimentRecord):
                await db.execute(delete(model))
            experiment = await db.get(Experiment, self.experiment_id)
            experiment.source_bundle = self.example["sourceBundle"]
            experiment.source_hash = self.example["bundleHash"]
            experiment.result_contracts = self.item()["measurement"]["experiment"]["simulationProgram"]["resultContracts"]
            await db.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()

    def item(self):
        return {"measurement": {"kind": "measurement", "experiment": {
            "kind": "experiment", "sourceHash": self.example["bundleHash"], "variables": {"fixed": 7},
            "varsSchema": {}, "scene": {}, "taskScenes": {}, "simulationProgram": {
                "resultContracts": {"signal": {"task": "fixture", "output": "signal", "solver": {"name": "fixture", "version": "1"}, "artifactType": "fixture", "catalogRevision": self.catalog.meta()["catalogRevision"], "visualization": {"kind": "tensor"}, "schema": {"dtype": "float64", "tensorOrder": 0, "quantityKind": "DimensionlessRatio"}}},
                "pythonSource": self.example["sourceBundle"]["files"]["simulate.py"], "tasks": {}, "recordedData": {
                "signal": {"dtype": "float64", "tensorOrder": 0, "quantityKind": "DimensionlessRatio"},
            }}}, "materialSnapshot": {"materials": {}}, "taskMaterialSnapshots": {},
            "modelDefinitions": [], "materialSelections": {}, "varsHash": material_vars_hash({"fixed": 7})}}

    async def create(self, *, count=1, request_id=None):
        raw = json.dumps(self.item(), separators=(",", ":"), ensure_ascii=False).encode()
        request = BatchCreateRequest(request_id=request_id or uuid.uuid4(), experiment_id=self.experiment_id,
            experiment_source_hash=self.example["bundleHash"], mode="generate",
            catalog_revision=self.catalog.meta()["catalogRevision"], builder_version="2",
            items=[{"index": index, "input_hash": hashlib.sha256(raw).hexdigest(), "byte_length": len(raw)}
                   for index in range(1, count + 1)])
        async with self.sessions() as db:
            batch = await create_batch(db, request, self.owner, self.catalog)
            return batch, request

    async def ready_job(self, batch_id, *, index=1, state="queued", attempt=1):
        async with self.sessions() as db:
            batch = await db.get(JobBatch, batch_id)
            job = await db.scalar(select(Job).where(Job.batch_id == batch_id, Job.item_index == index))
            job.input = self.item()
            job.state = state
            job.attempt_count = attempt
            db.add(Measurement(user_id=self.owner_id, experiment_id=self.experiment_id, job_id=job.id,
                vars={"fixed": 7}, material_snapshot={"experiment": {}, "tasks": {}}))
            batch.state = "queued"
            batch.uploaded_count += 1
            cae = await db.get(CaeBatch, batch.id)
            cae.spec = {**cae.spec, "committed": True}
            await db.commit()
            return job

    async def test_s3_input_and_record_commit_without_storing_large_bodies(self):
        import base64
        from storage.db import StorageObject
        from storage.service import prepare_upload, finish_upload, owned_object, cleanup_objects
        from cae.uploads import finalize_stored_item
        from datetime import timedelta
        value = self.item()
        value["measurement"]["experiment"]["scene"] = {"mesh": [0.125] * 20000}
        raw = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
        digest = hashlib.sha256(raw).hexdigest()
        request = BatchCreateRequest(request_id=uuid.uuid4(), experiment_id=self.experiment_id,
            experiment_source_hash=self.example["bundleHash"], mode="candidate", storage_version=1,
            catalog_revision=self.catalog.meta()["catalogRevision"], builder_version="2",
            items=[{"index": 1, "input_hash": digest, "byte_length": len(raw)}])
        bucket_objects = {}
        def head(**kwargs):
            content = bucket_objects[kwargs["Key"]]
            return {"ContentLength": len(content), "ChecksumSHA256": base64.b64encode(hashlib.sha256(content).digest()).decode()}
        bucket = SimpleNamespace(generate_presigned_url=lambda *args, **kwargs: "https://bucket.test/object",
                                 head_object=head, delete_object=lambda **kwargs: bucket_objects.pop(kwargs["Key"], None))
        with patch("storage.service.bucket_client", return_value=bucket):
            async with self.sessions() as db:
                batch = await create_batch(db, request, self.owner, self.catalog)
                job = await db.scalar(select(Job).where(Job.batch_id == batch.id))
                ticket = await prepare_upload(db, {"encoding": "json", "sha256": digest, "byteLength": len(raw),
                    "chunks": [{"sha256": digest, "byteLength": len(raw)}]}, user_id=self.owner_id,
                    experiment_id=self.experiment_id, purpose="input", job_id=job.id)
                input_id = ticket["reference"]["id"]
                bucket_objects[f"caemble/objects/{input_id}/00000000"] = raw
                await finish_upload(db, await owned_object(db, input_id, self.owner_id))
                await db.commit()
                await finalize_stored_item(db, batch.id, self.owner_id, 1, {"input": ticket["reference"], "projection": self.item()})
                await commit_batch(db, batch.id, self.owner, self.catalog)
                await db.refresh(job)
                self.assertLess(len(json.dumps(job.input)), 65536)
                self.assertEqual(job.input["artifact"], ticket["reference"])
                self.assertEqual(await db.scalar(select(func.count()).select_from(CaeUploadChunk)), 0)
                measurement = await db.scalar(select(Measurement).where(Measurement.job_id == job.id))
                measurement_id = measurement.id
                db.add(ExperimentRecord(experiment_id=self.experiment_id, name="signal", dtype="float64",
                    tensor_order=0, quantity_kind="DimensionlessRatio", data_schema={"dtype": "float64"}, contract_hash="a" * 64))
                record_raw = b"\x00" * 80000
                record_hash = hashlib.sha256(record_raw).hexdigest()
                record_ticket = await prepare_upload(db, {"encoding": "base64", "sha256": record_hash,
                    "byteLength": len(record_raw), "chunks": [{"sha256": record_hash, "byteLength": len(record_raw)}]},
                    user_id=self.owner_id, experiment_id=self.experiment_id, purpose="record", job_id=job.id,
                    attempt=job.attempt_count, measurement_id=measurement_id)
                record_id = record_ticket["reference"]["id"]
                bucket_objects[f"caemble/objects/{record_id}/00000000"] = record_raw
                await finish_upload(db, await owned_object(db, record_id, self.owner_id))
                await db.commit()
                packet = {"sequence": 1, "name": "signal", "value": {"shape": [10000],
                    "storage": {"kind": "base64", "data": record_ticket["reference"], "byteLength": len(record_raw)}}}
                await stage_record(db, job, packet, [])
                await db.commit()
                self.assertFalse((await db.get(StorageObject, record_id)).bound)
                await complete_job(db, job, {"recordSequences": [1]})
                await db.commit()
                self.assertTrue((await db.get(StorageObject, record_id)).bound)
                self.assertLess(len(json.dumps((await db.scalar(select(RecordedData))).data)), 1024)
                from db import Calculation, CalculationData
                from models import CalculationBase, CalculationDataOutput
                from service.calculation import upsert_calculations
                from service.calculation_data import save_calculation_data, analyze_calculation_data
                source_hash = hashlib.sha256(b"0").hexdigest()
                calculation = Calculation(experiment_id=self.experiment_id, name="s3-test", source_code="0",
                    source_hash=source_hash, contract_status="ready", output_layout={"dtype": "float64",
                        "shape": [20000], "axes": [{"name": "x", "ticks": list(range(20000)), "unit": None}]})
                db.add(calculation)
                await db.flush()
                calculated = json.dumps([0.125] * 20000).encode()
                calculated_hash = hashlib.sha256(calculated).hexdigest()
                calculated_ticket = await prepare_upload(db, {"encoding": "json", "sha256": calculated_hash,
                    "byteLength": len(calculated), "length": 20000,
                    "chunks": [{"sha256": calculated_hash, "byteLength": len(calculated)}]}, user_id=self.owner_id,
                    experiment_id=self.experiment_id, purpose="calculation", measurement_id=measurement_id,
                    calculation_id=calculation.id)
                calculated_id = calculated_ticket["reference"]["id"]
                bucket_objects[f"caemble/objects/{calculated_id}/00000000"] = calculated
                await finish_upload(db, await owned_object(db, calculated_id, self.owner_id))
                layout_ticket = await prepare_upload(db, {"encoding": "json", "sha256": calculated_hash,
                    "byteLength": len(calculated), "length": 20000,
                    "chunks": [{"sha256": calculated_hash, "byteLength": len(calculated)}]}, user_id=self.owner_id,
                    experiment_id=self.experiment_id, purpose="layout", request_id=str(uuid.uuid4()))
                layout_id = layout_ticket["reference"]["id"]
                bucket_objects[f"caemble/objects/{layout_id}/00000000"] = calculated
                await finish_upload(db, await owned_object(db, layout_id, self.owner_id))
                await upsert_calculations(db, [CalculationBase(id=calculation.id, base_revision=1,
                    experiment_id=self.experiment_id, name="s3-test", source_code="0", source_hash=source_hash, contract_status="ready",
                    experiment_record_ids=[], preflight_measurement_id=measurement_id, output_layout={
                        "dtype": "float64", "shape": [20000], "axes": [{"name": "x", "ticks": layout_ticket["reference"]}]})], user=self.owner)
                self.assertEqual((await db.get(StorageObject, layout_id)).calculation_id, calculation.id)
                self.assertLess(len(json.dumps(calculation.output_layout)), 1024)
                calculation_id = calculation.id
                summary = {"kind": "tensor", "rank": 1, "count": 20000, "mean": 0.125, "std": 0.0}
                output = CalculationDataOutput.model_validate({"dtype": "float64", "shape": [20000],
                    "axes": [{"name": "x", "ticks": calculated_ticket["reference"]}],
                    "data": calculated_ticket["reference"], "summary": summary})
                saved = await save_calculation_data(db, calculation.id, measurement_id, source_hash, output, user=self.owner)
                self.assertEqual((await analyze_calculation_data(db, self.experiment_id, user=self.owner))["items"][0]["summary"], summary)
                self.assertLess(len(json.dumps((await db.get(CalculationData, saved["id"])).data)), 2048)
                await db.execute(delete(CalculationData).where(CalculationData.id == saved["id"]))
                await db.execute(update(StorageObject).values(updated_at=utcnow() - timedelta(hours=25)))
                job.state = "succeeded"
                await db.commit()
            async with self.sessions() as db:
                await cleanup_objects(db)
                self.assertTrue((await db.get(StorageObject, calculated_id)).deleting)
                await db.execute(update(StorageObject).values(updated_at=utcnow() - timedelta(hours=25)))
                await db.commit()
                await cleanup_objects(db)
                self.assertEqual(await db.scalar(select(func.count()).select_from(StorageObject)), 3)
                self.assertNotIn(f"caemble/objects/{calculated_id}/00000000", bucket_objects)
                job = await db.get(Job, job.id)
                job.state = "succeeded"
                await db.execute(delete(Measurement).where(Measurement.id == measurement_id))
                await db.execute(delete(Calculation).where(Calculation.id == calculation_id))
                await db.execute(update(StorageObject).values(updated_at=utcnow() - timedelta(hours=25)))
                await db.commit()
            async with self.sessions() as db:
                await cleanup_objects(db)
                await db.execute(update(StorageObject).values(updated_at=utcnow() - timedelta(hours=25)))
                await db.commit()
                await cleanup_objects(db)
                self.assertEqual(await db.scalar(select(func.count()).select_from(StorageObject)), 0)
                self.assertEqual(bucket_objects, {})

    async def test_upload_commit_idempotence_and_owner_isolation(self):
        batch, request = await self.create(count=2)
        raw = json.dumps(self.item(), separators=(",", ":"), ensure_ascii=False).encode()
        sha = hashlib.sha256(raw).hexdigest()
        async with self.sessions() as db:
            duplicate = await create_batch(db, request, self.owner, self.catalog)
            self.assertEqual(duplicate.id, batch.id)
            self.assertEqual(await db.scalar(select(func.count()).select_from(Measurement)), 0)
            self.assertEqual(set((await db.scalars(select(Job.state))).all()), {"staged"})
            with self.assertRaises(HTTPException):
                await require_batch(db, batch.id, self.other_id)
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as error:
                await commit_batch(db, batch.id, self.owner, self.catalog)
            self.assertEqual(error.exception.status_code, 409)
        for index in (1, 2):
            async with self.sessions() as db:
                await upload_chunk(db, batch.id, self.owner_id, index, 0, sha, raw)
                await upload_chunk(db, batch.id, self.owner_id, index, 0, sha, raw)
                await finalize_item(db, batch.id, self.owner_id, index)
                await finalize_item(db, batch.id, self.owner_id, index)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(CaeUploadChunk)), 0)
            self.assertEqual(await db.scalar(select(func.count()).select_from(Measurement)), 0)
            committed = await commit_batch(db, batch.id, self.owner, self.catalog)
            self.assertEqual((committed.state, committed.uploaded_count), ("queued", 2))
            await commit_batch(db, batch.id, self.owner, self.catalog)
            self.assertEqual(await db.scalar(select(func.count()).select_from(Measurement)), 2)
            self.assertEqual(set((await db.scalars(select(Job.state))).all()), {"queued"})
            measurement_id = await db.scalar(select(Measurement.id).order_by(Measurement.id).limit(1))
            info = await measurement_artifact_info(db, measurement_id, self.owner_id)
            self.assertEqual(info["input_hash"], sha)
            self.assertEqual(info["source_hash"], self.example["bundleHash"])
            self.assertEqual(info["catalog_revision"], self.catalog.meta()["catalogRevision"])
            with self.assertRaises(HTTPException) as hidden:
                await measurement_artifact_info(db, measurement_id, self.other_id)
            self.assertEqual(hidden.exception.status_code, 404)


    async def test_partial_upload_cancel_cleans_data_and_never_executes(self):
        batch, request = await self.create(count=2)
        raw = json.dumps(self.item(), separators=(",", ":"), ensure_ascii=False).encode()
        async with self.sessions() as db:
            await upload_chunk(db, batch.id, self.owner_id, 1, 0, hashlib.sha256(raw).hexdigest(), raw)
            cancelled, assignments = await cancel_batch(db, batch.id, self.owner_id)
            self.assertEqual((cancelled.cancelled, assignments), (2, []))
            await cancel_batch(db, batch.id, self.owner_id)
            self.assertEqual(cancelled.cancelled, 2)
            self.assertEqual(await db.scalar(select(func.count()).select_from(CaeUploadChunk)), 0)
            self.assertEqual(await db.scalar(select(func.count()).select_from(Measurement)), 0)
            with self.assertRaises(HTTPException):
                await commit_batch(db, batch.id, self.owner, self.catalog)

    async def test_chunk_replacement_and_mismatched_hash_rejected(self):
        batch, request = await self.create()
        raw = json.dumps(self.item(), separators=(",", ":"), ensure_ascii=False).encode()
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as error:
                await upload_chunk(db, batch.id, self.owner_id, 1, 0, "0" * 64, raw)
            self.assertEqual(error.exception.status_code, 422)
        async with self.sessions() as db:
            await upload_chunk(db, batch.id, self.owner_id, 1, 0, hashlib.sha256(raw).hexdigest(), raw)
            changed = raw.replace(b"7", b"8", 1)
            with self.assertRaises(HTTPException) as error:
                await upload_chunk(db, batch.id, self.owner_id, 1, 0, hashlib.sha256(changed).hexdigest(), changed)
            self.assertEqual(error.exception.status_code, 409)

    async def test_upload_expiry_preserves_fresh_batches(self):
        from datetime import timedelta
        expired, _ = await self.create()
        fresh, _ = await self.create()
        async with self.sessions() as db:
            await db.execute(update(JobBatch).where(JobBatch.id == expired.id).values(updated_at=utcnow() - timedelta(hours=25)))
            await db.commit()
            self.assertEqual(await expire_uploads(db), 1)
            self.assertEqual((await db.get(JobBatch, expired.id)).state, "cancelled")
            self.assertEqual((await db.get(JobBatch, fresh.id)).state, "uploading")

    async def test_caemble_key_auth_uses_account_status_scope_and_revocation(self):
        from fastapi import Request
        from gpstation.models import AccessKeyCreate
        from gpstation.service.access_key_service import AccessKeyService
        from service.client_auth import authenticate_caemble
        from user_auth.db import Role, User, UserRole
        request = Request({"type": "http", "path": "/client/capabilities", "headers": []})
        async with self.sessions() as db:
            role_id = await db.scalar(select(Role.id).where(Role.name == "admin"))
            db.add(UserRole(user_id=self.owner_id, role_id=role_id))
            await db.commit()
            key = await AccessKeyService.create_user_access_key(db, self.owner_id,
                AccessKeyCreate(name="disposable-test", scopes=["caemble"]))
            token = "Bearer " + key.secret
            user = await authenticate_caemble(request, db, token)
            self.assertEqual((user.id, user.roles), (self.owner_id, [RoleEnum.user]))
            await AccessKeyService.revoke_access_keys(db, [key.access_key.id], user_id=self.owner_id)
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as rejected:
                await authenticate_caemble(request, db, token)
            self.assertEqual(rejected.exception.status_code, 401)
            await db.execute(delete(UserRole).where(UserRole.user_id == self.owner_id))
            await db.commit()

    async def test_calculation_revision_rejects_stale_concurrent_updates(self):
        from db import Calculation
        from service.calculation import upsert_calculations
        from test_calculation_database import _ready_calculation
        source = "export default () => ({ dtype: 'float64', data: 1 })"
        async with self.sessions() as db:
            measurement = Measurement(user_id=self.owner_id, experiment_id=self.experiment_id,
                vars={}, material_snapshot={}, recorded_at=utcnow())
            db.add(measurement)
            await db.commit()
            measurement_id = measurement.id
            created = await upsert_calculations(db, [_ready_calculation(
                self.experiment_id, "CAS", source, measurement_id
            )], user=self.owner)
            calculation_id = created[0]["id"]
            self.assertEqual(created[0]["revision"], 1)
        async def update_name(name):
            async with self.sessions() as db:
                try:
                    rows = await upsert_calculations(db, [_ready_calculation(
                        self.experiment_id, name, source, measurement_id,
                        calculation_id=calculation_id, base_revision=1,
                    )], user=self.owner)
                    return rows[0]["revision"]
                except HTTPException as error:
                    return error.status_code
        outcomes = await asyncio.wait_for(asyncio.gather(update_name("first"), update_name("second")), 5)
        self.assertEqual(sorted(outcomes), [2, 409])
        async with self.sessions() as db:
            self.assertEqual((await db.get(Calculation, calculation_id)).revision, 2)
            await db.execute(delete(Calculation).where(Calculation.id == calculation_id))
            await db.commit()

    async def test_large_item_chunks_resume_after_session_restart(self):
        value = self.item()
        value["presentation"] = {"padding": "x" * CHUNK_BYTES}
        raw = json.dumps(value, separators=(",", ":")).encode()
        request = BatchCreateRequest(request_id=uuid.uuid4(), experiment_id=self.experiment_id,
            experiment_source_hash=self.example["bundleHash"], mode="generate",
            catalog_revision=self.catalog.meta()["catalogRevision"], builder_version="2",
            items=[{"index": 1, "input_hash": hashlib.sha256(raw).hexdigest(), "byte_length": len(raw)}])
        async with self.sessions() as db:
            batch = await create_batch(db, request, self.owner, self.catalog)
            first = raw[:CHUNK_BYTES]
            await upload_chunk(db, batch.id, self.owner_id, 1, 0, hashlib.sha256(first).hexdigest(), first)
        async with self.sessions() as db:
            with self.assertRaises(HTTPException):
                await finalize_item(db, batch.id, self.owner_id, 1)
        async with self.sessions() as db:
            second = raw[CHUNK_BYTES:]
            await upload_chunk(db, batch.id, self.owner_id, 1, 1, hashlib.sha256(second).hexdigest(), second)
            await finalize_item(db, batch.id, self.owner_id, 1)
            await commit_batch(db, batch.id, self.owner, self.catalog)
            job = await db.scalar(select(Job).where(Job.batch_id == batch.id))
            self.assertEqual(job.input["measurement"], value["measurement"])
            self.assertEqual(job.artifact_metadata["presentation"], value["presentation"])

    async def test_commit_cancel_race_never_leaves_queued_work_in_cancelled_batch(self):
        batch, _ = await self.create()
        raw = json.dumps(self.item(), separators=(",", ":"), ensure_ascii=False).encode()
        async with self.sessions() as db:
            await upload_chunk(db, batch.id, self.owner_id, 1, 0, hashlib.sha256(raw).hexdigest(), raw)
            await finalize_item(db, batch.id, self.owner_id, 1)
        async def commit():
            async with self.sessions() as db:
                try:
                    await commit_batch(db, batch.id, self.owner, self.catalog)
                    return "committed"
                except HTTPException as error:
                    return error.status_code
        async def cancel():
            async with self.sessions() as db:
                await cancel_batch(db, batch.id, self.owner_id)
        await asyncio.wait_for(asyncio.gather(commit(), cancel()), 5)
        async with self.sessions() as db:
            current = await db.get(JobBatch, batch.id)
            self.assertEqual((current.state, current.cancelled), ("cancelled", 1))
            self.assertEqual(set((await db.scalars(select(Job.state))).all()), {"cancelled"})

    async def test_commit_streams_inputs_and_rolls_back_every_item_on_late_failure(self):
        batch, _ = await self.create(count=12)
        raw = json.dumps(self.item(), separators=(",", ":"), ensure_ascii=False).encode()
        for index in range(1, 13):
            async with self.sessions() as db:
                await upload_chunk(db, batch.id, self.owner_id, index, 0, hashlib.sha256(raw).hexdigest(), raw)
                await finalize_item(db, batch.id, self.owner_id, index)
        async with self.sessions() as db:
            last = await db.scalar(select(Job).where(Job.batch_id == batch.id, Job.item_index == 12))
            original = last.input
            broken = json.loads(json.dumps(original))
            broken["measurement"]["experiment"]["simulationProgram"]["pythonSource"] += "\n# changed"
            last.input = broken
            await db.commit()
        peak_loaded_jobs = 0
        async def count_live_inputs(db, batch, kind, **kwargs):
            nonlocal peak_loaded_jobs
            peak_loaded_jobs = max(peak_loaded_jobs, sum(isinstance(value, Job) for value in db.identity_map.values()))
            return await add_event(db, batch, kind, **kwargs)
        with patch("cae.uploads.add_event", new=count_live_inputs):
            async with self.sessions() as db:
                with self.assertRaises(HTTPException) as rejected:
                    await commit_batch(db, batch.id, self.owner, self.catalog)
                self.assertEqual(rejected.exception.status_code, 409)
                await db.rollback()
            async with self.sessions() as db:
                self.assertEqual(await db.scalar(select(func.count()).select_from(Measurement)), 0)
                self.assertEqual(set((await db.scalars(select(Job.state))).all()), {"staged"})
                self.assertFalse((await db.get(CaeBatch, batch.id)).spec.get("committed"))
                self.assertEqual(await db.scalar(select(func.count()).select_from(JobEvent).where(JobEvent.type == "job.queued")), 0)
                await db.execute(update(Job).where(Job.batch_id == batch.id, Job.item_index == 12).values(input=original))
                await db.commit()
            async with self.sessions() as db:
                await commit_batch(db, batch.id, self.owner, self.catalog)
                await commit_batch(db, batch.id, self.owner, self.catalog)
                self.assertEqual(await db.scalar(select(func.count()).select_from(Measurement)), 12)
                self.assertEqual(await db.scalar(select(func.count()).select_from(JobEvent).where(JobEvent.type == "job.queued")), 12)
                self.assertEqual(await db.scalar(select(func.count()).select_from(JobEvent).where(JobEvent.type == "batch.committed")), 1)
        self.assertLessEqual(peak_loaded_jobs, 2)

    async def test_object_jobs_wait_for_storage_capable_launcher(self):
        batch, _ = await self.create()
        job = await self.ready_job(batch.id)
        async with self.sessions() as db:
            await db.execute(update(Job).where(Job.id == job.id).values(input={**job.input, "storage_version": 1}))
            now = utcnow()
            launcher = Launcher(user_id=self.owner_id, launcher_name="legacy", status="ready", slave_app_ids=["cae"],
                job_modes={"cae": "websocket"}, storage_versions={}, connected_at=now, last_heartbeat_at=now)
            db.add(launcher)
            await db.commit()
            self.assertIsNone(await JobService.claim_next_compatible_job(db, idle_launcher_ids={launcher.id}))
            launcher.storage_versions = {"cae": 1}
            await db.commit()
            assignment = await JobService.claim_next_compatible_job(db, idle_launcher_ids={launcher.id})
            self.assertEqual(assignment[0].id, job.id)

    async def test_dispatch_rotates_between_compatible_batches(self):
        first, _ = await self.create(count=2)
        second, _ = await self.create()
        await self.ready_job(first.id, index=1)
        await self.ready_job(first.id, index=2)
        await self.ready_job(second.id)
        now = utcnow()
        async with self.sessions() as db:
            launchers = [Launcher(user_id=self.owner_id, launcher_name=str(i), status="ready", slave_app_ids=["cae"],
                job_modes={"cae": "websocket"}, connected_at=now, last_heartbeat_at=now) for i in range(2)]
            db.add_all(launchers)
            await db.commit()
            ids = {item.id for item in launchers}
            one = await JobService.claim_next_compatible_job(db, idle_launcher_ids=ids)
            two = await JobService.claim_next_compatible_job(db, idle_launcher_ids=ids)
            self.assertEqual((one[0].batch_id, two[0].batch_id), (first.id, second.id))
            self.assertEqual((one[0].item_index, two[0].item_index), (1, 1))

    async def test_concurrent_claims_obey_owner_capability_and_one_slot(self):
        batch, _ = await self.create(count=3)
        jobs = [await self.ready_job(batch.id, index=index) for index in range(1, 4)]
        now = utcnow()
        async with self.sessions() as db:
            launchers = [Launcher(user_id=owner, launcher_name=name, status="ready", slave_app_ids=["cae"],
                job_modes=modes, connected_at=now, last_heartbeat_at=now) for owner, name, modes in (
                (self.owner_id, "first", {"cae": "websocket"}),
                (self.owner_id, "second", {"cae": "websocket"}),
                (self.owner_id, "legacy", {}),
                (self.other_id, "other", {"cae": "websocket"}),
            )]
            db.add_all(launchers)
            await db.commit()
            ids = {launcher.id for launcher in launchers}
        async def claim():
            async with self.sessions() as db:
                return await JobService.claim_next_compatible_job(db, idle_launcher_ids=ids)
        assignments = await asyncio.gather(claim(), claim(), claim())
        assigned = [item for item in assignments if item]
        self.assertEqual(len(assigned), 2)
        self.assertEqual({item[1] for item in assigned}, {launchers[0].id, launchers[1].id})
        self.assertEqual(len({item[0].id for item in assigned}), 2)
        self.assertTrue(all(item[0].attempt_count == 1 for item in assigned))
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Job).where(Job.state == "queued")), 1)
            self.assertEqual(len(jobs), 3)

    async def test_restart_and_manual_retry_reuse_frozen_input(self):
        batch, _ = await self.create(count=2)
        running = await self.ready_job(batch.id, state="running")
        queued = await self.ready_job(batch.id, index=2)
        async with self.sessions() as db:
            failed = await fail_server_jobs(db, detail="server restarted", restarting=True)
            self.assertEqual([job.id for job in failed], [running.id])
        async with self.sessions() as db:
            self.assertEqual((await db.get(Job, queued.id)).state, "queued")
            self.assertEqual((await db.get(JobBatch, batch.id)).failed, 1)
            old_input = (await db.get(Job, running.id)).input
            retried = await retry_batch(db, batch.id, self.owner_id, [running.id])
            self.assertEqual(retried.failed, 0)
            job = await db.get(Job, running.id)
            self.assertEqual((job.state, job.attempt_count, job.input), ("queued", 2, old_input))
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as caught:
                await retry_batch(db, batch.id, self.owner_id, [queued.id])
            self.assertEqual(caught.exception.status_code, 409)

    async def test_staging_publish_atomicity_and_terminal_idempotence(self):
        batch, _ = await self.create()
        job = await self.ready_job(batch.id, state="running", attempt=2)
        async with self.sessions() as db:
            db.add(ExperimentRecord(experiment_id=self.experiment_id, name="signal", dtype="float64",
                tensor_order=0, quantity_kind="DimensionlessRatio", contract_hash="signal", data_schema={}))
            # A stale attempt's staging must not be included in this attempt.
            db.add(JobRecord(job_id=job.id, attempt_count=1, sequence=1, name="signal", payload={"stale": True}))
            await db.commit()
        packet = {"sequence": 1, "name": "signal", "value": {"shape": [], "storage": {"kind": "inline", "value": 7.5}}}
        async with self.sessions() as db:
            current = await db.get(Job, job.id)
            await stage_record(db, current, packet, [])
            await db.commit()
            await stage_record(db, current, packet, [])
            await db.commit()
            self.assertEqual(await db.scalar(select(func.count()).select_from(JobRecord).where(JobRecord.attempt_count == 2)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(RecordedData)), 0)
            measurement = await db.scalar(select(Measurement).where(Measurement.job_id == job.id))
            self.assertIsNone(measurement.recorded_at)
        async with self.sessions() as db:
            current = await db.get(Job, job.id)
            with self.assertRaises(ValueError):
                await stage_record(db, current, {**packet, "sequence": 3}, [])
            await db.rollback()
        async with self.sessions() as db:
            current = await db.get(Job, job.id)
            await complete_job(db, current, {"recordSequences": [1]})
            await db.rollback()
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(RecordedData)), 0)
            current = await db.get(Job, job.id)
            await serialize_events(db)
            result = await complete_job(db, current, {"recordSequences": [1]})
            self.assertTrue(await finish_job(db, current, "succeeded", result=result))
            await db.commit()
            self.assertFalse(await finish_job(db, current, "succeeded", result=result))
            await db.commit()
        async with self.sessions() as db:
            records = list((await db.scalars(select(RecordedData))).all())
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0].data, packet["value"])
            finished = await db.get(JobBatch, batch.id)
            self.assertEqual((finished.state, finished.succeeded), ("completed", 1))
            self.assertEqual(await db.scalar(select(func.count()).select_from(JobEvent).where(JobEvent.type == "job.succeeded")), 1)
            with self.assertRaises(ValueError):
                await complete_job(db, await db.get(Job, job.id), {"recordSequences": [1]})

    async def test_stale_cleanup_cannot_release_a_new_attempt(self):
        batch, _ = await self.create()
        job = await self.ready_job(batch.id, state="running", attempt=2)
        now = utcnow()
        async with self.sessions() as db:
            launcher = Launcher(user_id=self.owner_id, launcher_name="busy", status="busy", slave_app_ids=["cae"],
                job_modes={"cae": "websocket"}, connected_at=now, last_heartbeat_at=now)
            db.add(launcher)
            await db.flush()
            (await db.get(Job, job.id)).launcher_id = launcher.id
            launcher_id = launcher.id
            await db.commit()
            self.assertFalse(await worker_cleaned(db, job_id=job.id, attempt_count=1, launcher_id=launcher.id, user_id=self.owner_id))
            await db.rollback()
        async with self.sessions() as db:
            self.assertEqual((await db.get(Launcher, launcher_id)).status, "busy")
            self.assertEqual((await db.get(Job, job.id)).state, "running")

    async def test_sse_owner_replay_snapshot_cursor_and_persisted_read_state(self):
        batch, _ = await self.create()
        async with self.sessions() as db:
            snapshot = await list_batches(db, self.owner_id, experiment_id=None, limit=50, offset=0)
            cursor = snapshot["cursor"]
        async with self.sessions() as db:
            other = await create_batch(db, BatchCreateRequest(request_id=uuid.uuid4(),
                experiment_id=self.other_experiment_id, experiment_source_hash="hash-calc-other", mode="generate",
                catalog_revision=self.catalog.meta()["catalogRevision"], builder_version="2",
                items=[{"index": 1, "input_hash": "0" * 64, "byte_length": 100}]),
                UserData(id=self.other_id, roles=[RoleEnum.user]), self.catalog)
            other_event = other.last_event_id
        async with self.sessions() as db:
            await serialize_events(db)
            current = await db.get(JobBatch, batch.id)
            progress = await add_event(db, current, "job.progress", payload={"message": "계산 진행 중"})
            finished = await add_event(db, current, "job.succeeded", payload={"measurement_id": 37})
            await db.commit()
            progress_id, finished_id = progress.id, finished.id
        request = SimpleNamespace(headers={}, is_disconnected=AsyncMock(return_value=False))
        with patch("cae.events.SessionLocal", self.sessions):
            stream = stream_events(request, self.owner_id, cursor)
            try:
                frames = [await asyncio.wait_for(anext(stream), 2), await asyncio.wait_for(anext(stream), 2)]
            finally:
                await stream.aclose()
            events = [json.loads(frame.split("data: ", 1)[1]) for frame in frames]
            self.assertEqual([event["id"] for event in events], [progress_id, finished_id])
            self.assertTrue(all(event["batch_id"] == batch.id for event in events))
            self.assertEqual(events[0]["payload"]["message"], "계산 진행 중")
            self.assertEqual(events[1]["measurement_id"], 37)
            self.assertTrue(frames[0].startswith(f"id: {progress_id}\n"))

            resumed = stream_events(SimpleNamespace(headers={"last-event-id": str(progress_id)},
                is_disconnected=AsyncMock(return_value=False)), self.owner_id, cursor)
            try:
                event = json.loads((await asyncio.wait_for(anext(resumed), 2)).split("data: ", 1)[1])
                self.assertEqual(event["id"], finished_id)
            finally:
                await resumed.aclose()
            others = stream_events(request, self.other_id, 0)
            try:
                event = json.loads((await asyncio.wait_for(anext(others), 2)).split("data: ", 1)[1])
                self.assertEqual((event["id"], event["batch_id"]), (other_event, other.id))
            finally:
                await others.aclose()

        async def mark(event_id):
            async with self.sessions() as db:
                await mark_batch_read(db, batch.id, self.owner_id, event_id)
        await asyncio.gather(mark(finished_id), mark(progress_id), mark(cursor))
        async with self.sessions() as db:
            restored = await require_batch(db, batch.id, self.owner_id)
            self.assertEqual(restored.read_event_id, finished_id)
            await mark_batch_read(db, batch.id, self.owner_id, finished_id + 1000)
        async with self.sessions() as db:
            self.assertEqual((await db.get(JobBatch, batch.id)).read_event_id, finished_id)
            with self.assertRaises(HTTPException) as caught:
                await mark_batch_read(db, batch.id, self.other_id, finished_id)
            self.assertEqual(caught.exception.status_code, 404)

    async def test_retry_and_measurement_delete_cannot_both_succeed(self):
        batch, _ = await self.create()
        job = await self.ready_job(batch.id, state="running")
        async with self.sessions() as db:
            await serialize_events(db)
            await finish_job(db, await db.get(Job, job.id), "failed", "interrupted")
            await db.commit()
            measurement_id = await db.scalar(select(Measurement.id).where(Measurement.job_id == job.id))
        async def retry():
            async with self.sessions() as db:
                try:
                    await retry_batch(db, batch.id, self.owner_id, [job.id])
                    return "retried"
                except HTTPException as error:
                    return error.status_code
        async def remove():
            async with self.sessions() as db:
                try:
                    await delete_measurements(db, [measurement_id], user=self.owner)
                    return "deleted"
                except HTTPException as error:
                    return error.status_code
        outcome = await asyncio.wait_for(asyncio.gather(retry(), remove()), 5)
        self.assertIn(outcome, (["retried", 409], [409, "deleted"]))
        async with self.sessions() as db:
            current = await db.get(Job, job.id)
            measurement = await db.get(Measurement, measurement_id)
            if outcome[0] == "retried":
                self.assertEqual((current.state, current.attempt_count), ("queued", 2))
                self.assertIsNotNone(measurement)
            else:
                self.assertEqual((current.state, current.attempt_count), ("failed", 1))
                self.assertIsNone(measurement)

    def test_additive_migration_preserves_existing_rows(self):
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        try:
            asyncio.run(_create_database(database))
            _upgrade(database, "000000000007")
            owner_id, _, experiment_id, _ = asyncio.run(_seed_owners(database))
            async def seed_existing():
                engine = create_async_engine(make_async_db_url(_database_url(database)))
                try:
                    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                        job = Job(user_id=owner_id, handler_type="ai.chat", slave_app_id="ai", state="succeeded", offer={"sdp": "retained"})
                        measurement = Measurement(user_id=owner_id, experiment_id=experiment_id, vars={"retained": 1},
                            material_snapshot={"retained": True}, recorded_at=utcnow())
                        record = ExperimentRecord(experiment_id=experiment_id, name="signal", dtype="float64",
                            tensor_order=0, contract_hash="retained", data_schema={})
                        db.add_all([job, measurement, record])
                        await db.flush()
                        db.add(RecordedData(user_id=owner_id, measurement_id=measurement.id, experiment_record_id=record.id,
                            data={"shape": [], "storage": {"kind": "inline", "value": 42}}))
                        await db.commit()
                        return job.id, measurement.id
                finally:
                    await engine.dispose()
            job_id, measurement_id = asyncio.run(seed_existing())
            settings.db_url = _database_url(database)
            try:
                command.downgrade(Config(str(API_DIR / "alembic.ini")), "000000000005")
            finally:
                settings.db_url = ORIGINAL_DB_URL
            self.assertNotIn("job_batches", asyncio.run(_table_names(database)))
            _upgrade(database, "head")
            _check(database)
            self.assertTrue({"job_batches", "cae_batches", "job_events", "job_records"}.issubset(asyncio.run(_table_names(database))))
            async def verify():
                engine = create_async_engine(make_async_db_url(_database_url(database)))
                try:
                    async with async_sessionmaker(engine)() as db:
                        self.assertEqual(await db.scalar(select(func.count()).select_from(Experiment)), 2)
                        job = await db.get(Job, job_id)
                        self.assertEqual((job.job_mode, job.offer, job.state), ("webrtc", {"sdp": "retained"}, "succeeded"))
                        measurement = await db.get(Measurement, measurement_id)
                        self.assertEqual(measurement.vars, {"retained": 1})
                        self.assertIsNotNone(measurement.recorded_at)
                        record = await db.scalar(select(RecordedData).where(RecordedData.measurement_id == measurement_id))
                        self.assertEqual(record.data["storage"]["value"], 42)
                finally:
                    await engine.dispose()
            asyncio.run(verify())
        finally:
            settings.db_url = ORIGINAL_DB_URL
            asyncio.run(_drop_database(database))


if __name__ == "__main__":
    unittest.main()
