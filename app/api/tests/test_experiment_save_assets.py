"""Exercise the new save transaction against a disposable PostgreSQL database."""
import asyncio
import base64
import io
import os
import sys
import unittest
import uuid
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from PIL import Image
from fastapi import HTTPException
from sqlalchemy import select, func, delete
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from db import Experiment, ExperimentThumbnail, Measurement, MeasurementSnapshot, RecordedData, make_async_db_url
from cae.db import CaeBatch
from cae.preflight import expire_preflights
from cae.uploads import measurement_artifact
from gpstation.db import Job, JobBatch
from gpstation.service.state import utcnow
from models import SaveExperimentRequest, UserData, RoleEnum
from service.experiment import save_experiment, _bundle_hash
from service.experiment_save_assets import thumbnail_bytes
from routers.experiment import read_thumbnail
from storage.db import StorageObject
from storage.service import reference
from box_grid_fixtures import box_schema, box_tensor
from test_calculation_database import _create_database, _database_url, _drop_database, _seed_owners, _upgrade

SCHEMA = box_schema()
CONTRACT = {"task": "fixture", "output": "signal", "solver": {"name": "fixture", "version": "1.0.0"},
            "artifactType": "fixture@1", "catalogRevision": "fixture", "visualization": {"kind": "tensor"}, "schema": SCHEMA}
CREATE = dict(mode="create", namespace="calc-owner", repository="assets", key="saved", name="Saved",
    sourceBundle={"files": {"experiment.tsx": "export default null"}}, bundleHash="computed-by-server",
    records=[{"name": "signal", "quantity_kind": "Dimensionless", "tensor_order": 0, "dtype": "float64", "data_schema": SCHEMA}],
    result_contracts={"signal": CONTRACT})


def image_url(size=(640, 480), format="WEBP"):
    output = io.BytesIO()
    Image.new("RGB", size, "navy").save(output, format=format)
    return "data:image/webp;base64," + base64.b64encode(output.getvalue()).decode()


class ThumbnailValidationTests(unittest.TestCase):
    def test_valid_and_rejected_images(self):
        self.assertTrue(thumbnail_bytes(image_url()))
        self.assertIsNone(thumbnail_bytes(None))
        for value in (image_url((640, 400)), image_url((800, 600)), image_url(format="PNG"), "data:image/webp;base64,!!", "data:image/webp;base64," + base64.b64encode(b'x' * (512 * 1024 + 1)).decode()):
            with self.subTest(value=value[:30]), self.assertRaises(HTTPException):
                thumbnail_bytes(value)


@unittest.skipUnless(os.getenv("RUN_CALCULATION_DB_TESTS") == "1", "Requires disposable PostgreSQL databases")
class ExperimentSaveAssetsDatabaseTests(unittest.TestCase):
    def test_atomic_promotion_replay_permissions_concurrency_and_expiry(self):
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"

        async def verify():
            owner_id, other_id, _, _ = await _seed_owners(database)
            owner = UserData(id=owner_id, roles=[RoleEnum.user])
            other = UserData(id=other_id, roles=[RoleEnum.user])
            engine = create_async_engine(make_async_db_url(_database_url(database)))
            sessions = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with sessions() as db:
                    batch = JobBatch(user_id=owner_id, request_id=str(uuid.uuid4()), request_hash="fixture", total=1)
                    db.add(batch)
                    await db.flush()
                    source_hash = _bundle_hash(CREATE["sourceBundle"])
                    spec = {"preflight": True, "source_bundle": CREATE["sourceBundle"], "source_hash": source_hash}
                    db.add(CaeBatch(batch_id=batch.id, spec=spec))
                    frozen = {"experiment": {"sourceHash": source_hash, "variables": {"length": 4},
                        "simulationProgram": {"recordedData": {"signal": SCHEMA}, "resultContracts": CREATE["result_contracts"]}},
                        "varsHash": "vars", "materialSnapshot": {}, "taskMaterialSnapshots": {}, "modelDefinitions": {}, "materialSelections": {}}
                    job = Job(user_id=owner_id, batch_id=batch.id, item_index=0, handler_type="cae", slave_app_id="cae",
                        state="succeeded", finished_at=utcnow(), input={"measurement": frozen, "preflight": True},
                        artifact_metadata={"recorded_data": {"signal": box_tensor()}, "visualizations": {}, "execution_trace": [{"task": "fixture"}]})
                    db.add(job)
                    await db.flush()
                    source = StorageObject(id=str(uuid.uuid4()), user_id=owner_id, job_id=job.id, purpose="input", ready=True, bound=True,
                        manifest={"encoding": "json", "byteLength": 3, "sha256": "a" * 64, "chunks": [{"sha256": "a" * 64, "byteLength": 3}]})
                    db.add(source)
                    await db.flush()
                    job.input = {**job.input, "artifact": reference(source)}
                    await db.commit()
                    batch_id, job_id, source_id = batch.id, job.id, source.id
                    request = SaveExperimentRequest(**CREATE, requestId=str(uuid.uuid4()), preflightBatchId=batch_id, thumbnail=image_url())
                    client = Mock()
                    with patch("service.experiment_save_assets.bucket_client", return_value=client):
                        result = await save_experiment(db, request, user=owner)
                        replay = await save_experiment(db, request, user=owner)
                    self.assertEqual(result, replay)
                    self.assertEqual(client.copy_object.call_count, 1)
                    self.assertEqual(result["derivedCounts"]["measurements"], 1)
                    self.assertIsNotNone(await db.get(ExperimentThumbnail, result["id"]))
                    self.assertEqual((await read_thumbnail(result["id"], db, owner)).media_type, "image/webp")
                    for actor in (None, other):
                        with self.assertRaises(HTTPException) as denied:
                            await read_thumbnail(result["id"], db, actor)
                        self.assertEqual(denied.exception.status_code, 404)
                    snapshot = await db.get(MeasurementSnapshot, result["measurementId"])
                    self.assertEqual(snapshot.execution_trace, [{"task": "fixture"}])
                    permanent_ref = await measurement_artifact(db, result["measurementId"], owner_id)
                    self.assertNotEqual(permanent_ref["id"], source_id)
                    permanent = await db.get(StorageObject, permanent_ref["id"])
                    self.assertIsNone(permanent.job_id)
                    self.assertEqual(permanent.measurement_id, result["measurementId"])
                    self.assertEqual((await db.get(Measurement, result["measurementId"])).vars, {"length": 4})
                    await db.commit()

                    with patch("service.experiment_save_assets.bucket_client", return_value=client):
                        second_copy = await save_experiment(db, SaveExperimentRequest(**{**CREATE, "key": "independent"},
                            preflightBatchId=batch_id, requestId=str(uuid.uuid4())), user=owner)
                    second_ref = await measurement_artifact(db, second_copy["measurementId"], owner_id)
                    self.assertNotEqual(second_ref["id"], permanent_ref["id"])
                    await db.commit()

                    async def rejected(fields, status, actor=owner):
                        async with sessions() as check:
                            before = await check.scalar(select(func.count()).select_from(Experiment))
                            with self.assertRaises(HTTPException) as error:
                                await save_experiment(check, SaveExperimentRequest(**{**CREATE, "requestId": str(uuid.uuid4()), **fields}), user=actor)
                            self.assertEqual(error.exception.status_code, status)
                            self.assertEqual(await check.scalar(select(func.count()).select_from(Experiment)), before)

                    await rejected({"name": "different", "requestId": request.requestId, "preflightBatchId": batch_id}, 409)
                    await rejected({"key": "mismatch", "sourceBundle": {"files": {"experiment.tsx": "changed"}}, "preflightBatchId": batch_id}, 409)
                    await rejected({"key": "contract-mismatch", "records": [], "result_contracts": {}, "preflightBatchId": batch_id}, 409)
                    await rejected({"key": "forbidden", "namespace": "calc-other", "preflightBatchId": batch_id}, 404, other)
                    await rejected({"mode": "overwrite", "experimentId": result["id"], "baseBundleHash": result["bundleHash"]}, 409)

                    with patch("service.experiment_save_assets.bucket_client", return_value=Mock(copy_object=Mock(side_effect=RuntimeError("copy failed")))):
                        with self.assertRaisesRegex(RuntimeError, "copy failed"):
                            await save_experiment(db, SaveExperimentRequest(**{**CREATE, "key": "rollback"}, preflightBatchId=batch_id, requestId=str(uuid.uuid4()), thumbnail=image_url()), user=owner)
                    self.assertIsNone(await db.scalar(select(Experiment.id).where(Experiment.experiment_key == "rollback")))
                    tombstones = (await db.scalars(select(StorageObject).where(StorageObject.deleting == True))).all()
                    self.assertEqual(len(tombstones), 1)
                    self.assertFalse(tombstones[0].bound)
                    await db.commit()

                    # Same request in two transactions creates one version and one receipt.
                    concurrent = SaveExperimentRequest(**{**CREATE, "key": "concurrent"}, requestId=str(uuid.uuid4()))
                    async def save_concurrently(body):
                        async with sessions() as session:
                            return await save_experiment(session, body, user=owner)
                    first, second = await asyncio.gather(save_concurrently(concurrent), save_concurrently(concurrent))
                    self.assertEqual(first, second)
                    version_args = {**CREATE, "key": "concurrent", "mode": "new_version", "experimentId": first["id"], "baseBundleHash": first["bundleHash"], "bump": "patch"}
                    versions = await asyncio.gather(*(save_concurrently(SaveExperimentRequest(**version_args, requestId=str(uuid.uuid4()))) for _ in range(2)))
                    self.assertEqual({row["version"] for row in versions}, {"0.1.1", "0.1.2"})
                    overwrite_args = {**CREATE, "key": "concurrent", "mode": "overwrite", "experimentId": first["id"], "baseBundleHash": first["bundleHash"], "sourceBundle": {"files": {"experiment.tsx": "changed"}}}
                    overwritten = await save_concurrently(SaveExperimentRequest(**overwrite_args, requestId=str(uuid.uuid4())))
                    self.assertNotEqual(overwritten["bundleHash"], first["bundleHash"])
                    await rejected({**overwrite_args}, 409)

                    expired_job = await db.get(Job, job_id)
                    expired_job.finished_at = utcnow() - timedelta(hours=25)
                    await db.commit()
                    await rejected({"key": "expired", "preflightBatchId": batch_id}, 410)
                    await expire_preflights(db)
                    db.expire_all()
                    self.assertEqual(await measurement_artifact(db, result["measurementId"], owner_id), permanent_ref)
                    self.assertFalse((await db.get(StorageObject, permanent_ref["id"])).deleting)
                    self.assertTrue((await db.get(StorageObject, source_id)).deleting)
                    self.assertIsNotNone(await db.scalar(select(RecordedData).where(RecordedData.measurement_id == result["measurementId"])))
                    await db.execute(delete(Experiment).where(Experiment.id == result["id"]))
                    await db.commit()
                    self.assertEqual(await measurement_artifact(db, second_copy["measurementId"], owner_id), second_ref)
                    self.assertFalse((await db.get(StorageObject, second_ref["id"])).deleting)
            finally:
                await engine.dispose()

        asyncio.run(_create_database(database))
        try:
            _upgrade(database, "head")
            asyncio.run(verify())
        finally:
            asyncio.run(_drop_database(database))
