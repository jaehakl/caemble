"""Real API grants/PostgreSQL and Predictor ZIPs over loopback HTTP, without S3 credentials."""
import asyncio
import base64
import hashlib
import importlib.util
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from fastapi import FastAPI, Request, Response
import httpx
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
import uvicorn

import test_prediction_assets as fixtures
from db import get_db, make_async_db_url
from gpstation.db import Job, Launcher
from gpstation.service.batches import finish_job
from gpstation.service.state import utcnow
from gpstation.utils.csrf import require_web_csrf
from prediction.common import canonical_bytes
from prediction import training
from prediction.datasets import source_contracts
from prediction.db import Dataset, DatasetGrant, DatasetRevision, Operation
from prediction.replicas import managed_storage, put_replica
from prediction.router import authenticated, router
from settings import settings
from test_calculation_database import _database_url


PREDICTOR = Path(__file__).resolve().parents[2] / "slaves" / "cae_prediction"
spec = importlib.util.spec_from_file_location("predictor", PREDICTOR / "app" / "__init__.py",
                                            submodule_search_locations=[str(PREDICTOR / "app")])
module = importlib.util.module_from_spec(spec)
sys.modules["predictor"] = module
spec.loader.exec_module(module)
spec = importlib.util.spec_from_file_location("predictor_fixture", PREDICTOR / "tests" / "fixtures.py")
sample = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sample)
from predictor.errors import PredictionError
from predictor.runtime import PredictorRuntime


class HttpBucket:
    def __init__(self):
        self.parts = {}
        self.url = ""
        self.uploads = 0

    def generate_presigned_url(self, method, Params, ExpiresIn):
        return self.url + "/bucket/" + Params["Key"]

    def head_object(self, Bucket, Key, ChecksumMode):
        raw = self.parts[Key]
        return {"ContentLength": len(raw), "ChecksumSHA256": base64.b64encode(hashlib.sha256(raw).digest()).decode()}

    def delete_object(self, Bucket, Key):
        self.parts.pop(Key, None)


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class PredictionTransferIntegrationTests(unittest.IsolatedAsyncioTestCase):
    setUpClass = classmethod(fixtures.PredictionAssetsTests.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.PredictionAssetsTests.tearDownClass.__func__)

    async def asyncSetUp(self):
        await fixtures.PredictionAssetsTests.asyncSetUp(self)
        self.temporary = tempfile.TemporaryDirectory(prefix="prediction-api-transfer-")
        self.bucket = HttpBucket()
        self.lost_response = None
        self.api_engine = create_async_engine(make_async_db_url(_database_url(self.database)), poolclass=NullPool)
        api_sessions = async_sessionmaker(self.api_engine, expire_on_commit=False)

        async def database():
            async with api_sessions() as session:
                yield session

        app = FastAPI()
        app.dependency_overrides[get_db] = database
        app.dependency_overrides[authenticated] = lambda: SimpleNamespace(id=self.owner)
        app.dependency_overrides[require_web_csrf] = lambda: None
        app.include_router(router)

        @app.middleware("http")
        async def lose_completed_reply(request, call_next):
            response = await call_next(request)
            if request.url.path == self.lost_response and response.status_code == 200:
                self.lost_response = None
                return Response(status_code=503)
            return response

        @app.api_route("/bucket/{key:path}", methods=["GET", "PUT"])
        async def bucket_part(key: str, request: Request):
            if request.method == "PUT":
                if key in self.bucket.parts:
                    return Response(status_code=412)
                raw = await request.body()
                expected = base64.b64encode(hashlib.sha256(raw).digest()).decode()
                if request.headers.get("x-amz-checksum-sha256") != expected:
                    return Response(status_code=400)
                self.bucket.parts[key] = raw
                self.bucket.uploads += 1
                return Response(status_code=200)
            return Response(self.bucket.parts[key], media_type="application/octet-stream")

        self.socket = socket.socket()
        self.socket.bind(("127.0.0.1", 0))
        self.url = f"http://127.0.0.1:{self.socket.getsockname()[1]}"
        self.bucket.url = self.url
        self.patches = [patch.object(settings, "public_api_base_url", self.url),
                        patch("storage.service.bucket_client", return_value=self.bucket)]
        for item in self.patches:
            item.start()
        self.server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
        self.thread = threading.Thread(target=lambda: self.server.run(sockets=[self.socket]), daemon=True)
        self.thread.start()
        for _ in range(100):
            if self.server.started:
                break
            await asyncio.sleep(.02)
        self.assertTrue(self.server.started)
        self.client = httpx.AsyncClient(base_url=self.url, timeout=30)

    async def asyncTearDown(self):
        await self.client.aclose()
        self.server.should_exit = True
        await asyncio.to_thread(self.thread.join, 10)
        self.assertFalse(self.thread.is_alive())
        self.socket.close()
        await self.api_engine.dispose()
        for item in reversed(self.patches):
            item.stop()
        self.temporary.cleanup()
        await fixtures.PredictionAssetsTests.asyncTearDown(self)

    async def post(self, path, body):
        response = await self.client.post(path, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def rpc(self, worker, action, **payload):
        return await asyncio.to_thread(worker.dispatch, action, {"protocolVersion": 3, "requestId": str(uuid4()),
            "sessionId": worker.session_id, **payload})

    async def worker(self, name, launcher_id=None):
        launcher_id = launcher_id or str(uuid4())
        if launcher_id != self.launcher_id:
            async with self.sessions() as db:
                db.add(Launcher(id=launcher_id, user_id=self.owner, installation_id=str(uuid4()), launcher_name=name,
                    status="ready", connected_at=utcnow(), last_heartbeat_at=utcnow(), slave_app_ids=["predictor"]))
                await db.commit()
        worker = PredictorRuntime(Path(self.temporary.name) / name, self.owner, launcher_id, self.url, 128 * 1024 * 1024)
        await self.post("/prediction/storages", {"storage_id": worker.store.storage_id, "launcher_id": launcher_id, "name": name})
        return worker

    async def test_real_grants_ephemeral_dataset_split_launchers_and_lost_reply(self):
        source = await self.worker("model-source", self.launcher_id)
        data = sample.dataset()
        data.update(datasetId=str(uuid4()), experimentId=self.experiment_id, sourceHash="a" * 64)
        for calculation in data["calculations"]:
            calculation.update(source_revision=1, revision=1, contract_status="ready")
        data["fingerprint"] = "sha256:" + hashlib.sha256(canonical_bytes(data)).hexdigest()
        definition = sample.definition(data)
        async with self.sessions() as db:
            db.add(Dataset(id=data["datasetId"], user_id=self.owner, experiment_id=self.experiment_id,
                name=data["name"], source_kind="server", selection={}, current_revision=1))
            await db.flush()
            db.add(DatasetRevision(dataset_id=data["datasetId"], revision=1, request_id=str(uuid4()),
                request_hash="a" * 64, fingerprint=data["fingerprint"], payload=data,
                summary={"source_contracts": source_contracts(data), "sample_count": len(data["measurements"])}))
            await db.flush()
            api_store = await managed_storage(db, self.owner, "api_dataset")
            await put_replica(db, "dataset", data["datasetId"], 1, api_store.storage_id,
                artifact={"manifest_sha256": hashlib.sha256(canonical_bytes(data)).hexdigest(), "fingerprint": data["fingerprint"]})
            await db.commit()
        prepare_id = str(uuid4())
        reserved = await self.post("/prediction/models/reserve", {"request_id": prepare_id, "name": "Portable model",
            "direction": "forward", "dataset_id": data["datasetId"], "dataset_revision": 1, "definition": definition,
            "storage_id": source.store.storage_id, "launcher_id": source.store.launcher_id})
        async with self.sessions() as db:
            launcher = await db.get(Launcher, self.launcher_id)
            launcher.slave_app_ids = ["predictor", "predictor-training"]
            launcher.job_modes = {"predictor": "webrtc", "predictor-training": "websocket"}
            await db.commit()
        pin = await self.rpc(source, "training.pin", grant=reserved["training"]["grant"])
        submitted = await self.post(f"/prediction/operations/{prepare_id}/submit", {"pin_id": pin["pinId"]})
        token = str(uuid4())
        async with self.sessions() as db:
            job = await db.get(Job, submitted["training"]["jobId"])
            job.launcher_id, job.state = self.launcher_id, "running"
            job.worker_token_hash = hashlib.sha256(token.encode()).hexdigest()
            assigned = job.input
            await db.commit()
        def dataset_reference():
            response = httpx.get(assigned["datasetAccessUrl"], headers={"Authorization": f"Bearer {token}"})
            response.raise_for_status()
            return response.json()
        prepared = await asyncio.to_thread(source.training.train, assigned, dataset_reference)
        self.assertEqual(source.store.list("datasets"), [])  # Model preparation only stages the granted payload.
        artifact = prepared["artifact"]
        complete_body = {"request_id": prepare_id, "manifest_sha256": artifact["manifestChecksum"], "files": artifact["files"],
            "profile": artifact["profile"], "input_layouts": artifact["inputLayouts"], "output_layouts": artifact["outputLayouts"],
            "validation": artifact["validation"], "training_metrics": artifact["trainingMetrics"],
            "execution_metrics": artifact["executionMetrics"], "verified": False}
        hello = await self.rpc(source, "predictor.hello")
        self.assertFalse(hello["models"][0]["verified"])
        rejected = await self.client.post(f"/prediction/models/{reserved['id']}/revisions/1/complete", json=complete_body)
        self.assertEqual(rejected.status_code, 410)
        async with self.sessions() as db:
            job = await db.get(Job, submitted["training"]["jobId"])
            result = await training.complete_job(db, job, prepared)
            await finish_job(db, job, "succeeded", result=result)
            job.cleaned_at = utcnow()
            await db.commit()
            await training.reconcile(db)
        completed = await self.post(f"/prediction/models/{reserved['id']}/revisions/1/complete", {**complete_body, "verified": True})
        self.assertEqual(completed["revisions"][0]["replicas"][0]["state"], "present")
        self.assertEqual(completed["revisions"][0]["artifact"]["training_metrics"], artifact["trainingMetrics"])
        self.assertEqual(completed["revisions"][0]["artifact"]["validation"], artifact["validation"])
        model_copy = completed["revisions"][0]["replicas"][0]["id"]
        logical = {"modelId": reserved["id"], "revision": 1, "manifestChecksum": artifact["manifestChecksum"]}
        backup = await self.post("/prediction/operations", {"request_id": str(uuid4()), "kind": "backup", "asset_id": reserved["id"],
            "revision": 1, "source_replica_id": model_copy, "source_launcher_id": self.launcher_id, "include_dataset": True})
        payload = {"operationId": backup["id"], "grant": backup["grant"], "model": logical, "includeDataset": True,
                   "datasetSource": {"grant": backup["dataset_grant"]}}
        self.lost_response = f"/prediction/operations/{backup['id']}/complete"
        with self.assertRaisesRegex(PredictionError, "HTTP 503"):
            await self.rpc(source, "artifact.backup", **payload)
        uploads = self.bucket.uploads
        async with self.sessions() as db:
            self.assertEqual((await db.get(Operation, backup["id"])).state, "completed")
            self.assertIsNone(await db.get(DatasetGrant, backup["dataset_grant"]["grant_id"]))
        result = await self.rpc(source, "artifact.backup", **payload)
        self.assertEqual(result["receipt"]["state"], "complete")
        self.assertEqual(self.bucket.uploads, uploads)
        copies = result["operation"]["details"]["result_replicas"]
        target = await self.worker("restore-target")
        restore = await self.post("/prediction/operations", {"request_id": str(uuid4()), "kind": "restore", "asset_id": reserved["id"],
            "revision": 1, "source_replica_id": copies["model"], "include_dataset": True, "dataset_source_replica_id": copies["dataset"],
            "target_storage_id": target.store.storage_id, "target_launcher_id": target.store.launcher_id})
        restored = await self.rpc(target, "artifact.restore", operationId=restore["id"], grant=restore["grant"])
        self.assertEqual(restored["operation"]["state"], "completed")
        restored_manifest, _, _ = target.store.read("models", reserved["id"], 1)
        self.assertEqual(restored_manifest["metadata"]["trainingMetrics"], artifact["trainingMetrics"])
        dataset_copy = restored["operation"]["details"]["result_replicas"]["dataset"]
        # A second backup sources the model from A and the exact restored Dataset from B.
        split = await self.post("/prediction/operations", {"request_id": str(uuid4()), "kind": "backup", "asset_id": reserved["id"],
            "revision": 1, "source_replica_id": model_copy, "source_launcher_id": self.launcher_id, "include_dataset": True,
            "dataset_source_replica_id": dataset_copy, "dataset_source_launcher_id": target.store.launcher_id})
        split_body = {"operationId": split["id"], "grant": split["grant"], "model": logical, "includeDataset": True}
        partial = await self.rpc(source, "artifact.backup", **split_body, slots=["model"])
        self.assertEqual(partial["receipt"]["state"], "uploaded")
        final = await self.rpc(target, "artifact.backup", **split_body, slots=["dataset"],
            datasetSource={"local": {key: data[key] for key in ("datasetId", "revision", "fingerprint")}})
        self.assertEqual(final["receipt"]["state"], "complete")
        reconciled = await self.rpc(source, "operation.inspect", operationId=split["id"], grant=split["grant"])
        self.assertEqual(reconciled["receipt"]["state"], "complete")
        self.assertFalse((source.store.path("operations", split["id"]) / "archives").exists())
        source.store.remove_replica("models", reserved["id"], 1)
        loaded = await self.rpc(target, "model.load", **logical)
        prediction = await self.rpc(target, "model.predict", instance=loaded["instance"], input={"direction": "forward", "vars": {"x": .5}})
        self.assertEqual(prediction["output"][0]["values"], [15.0])
        self.assertEqual(loaded["artifact"]["manifestChecksum"], artifact["manifestChecksum"])
        self.assertEqual(loaded["artifact"]["storageId"], target.store.storage_id)
        await self.rpc(target, "model.release", instance=loaded["instance"])
