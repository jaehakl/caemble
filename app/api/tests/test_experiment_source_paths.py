"""Write/run boundary regressions without a database or Solver."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from cae.batches import create_batch, retry_batch
from cae.models import BatchCreateRequest
from cae.uploads import commit_batch
from models import ExperimentSourceBundle, SaveExperimentRequest
from service.experiment import save_experiment

BAD = {"files": {"experiment.tsx": "export default null", "object.ts": "unused"}}


class SourcePathTests(unittest.IsolatedAsyncioTestCase):
    def assert_path_error(self, error):
        self.assertEqual(error.exception.status_code, 422)
        self.assertIn("object.ts", error.exception.detail)
        self.assertIn("Allowed: experiment.tsx", error.exception.detail)

    def test_legacy_bundle_remains_readable(self):
        self.assertEqual(ExperimentSourceBundle(**BAD).files["object.ts"], "unused")

    def test_direct_save_api_rejects_before_any_database_write(self):
        db = SimpleNamespace(rollback=AsyncMock(), add=Mock())
        app = FastAPI()

        @app.post("/save")
        async def save(request: SaveExperimentRequest):
            return await save_experiment(db, request, user=SimpleNamespace(id="owner"))

        request = dict(mode="create", namespace="test", repository="experiments", key="test", name="Test",
                       sourceBundle=BAD, bundleHash="hash", records=[], result_contracts={})
        with TestClient(app) as client:
            for mode in ("create", "overwrite", "new_version"):
                response = client.post("/save", json={**request, "mode": mode})
                self.assertEqual(response.status_code, 422)
                self.assertIn("object.ts", response.json()["detail"])
            response = client.post("/save", json={**request, "requestId": "11111111-1111-4111-8111-111111111111"})
            self.assertEqual(response.status_code, 422)
        db.add.assert_not_called()

    async def test_new_batch_and_preflight_reject_legacy_source(self):
        catalog = SimpleNamespace(meta=lambda: {"catalogRevision": "catalog"})
        user = SimpleNamespace(id="owner")
        experiment = SimpleNamespace(user_id="owner", source_hash="source", source_bundle=BAD)
        for preflight in (True, False):
            request = BatchCreateRequest(request_id="11111111-1111-4111-8111-111111111111",
                experiment_source_hash="source", mode="candidate", catalog_revision="catalog",
                builder_version="2", storage_version=1, preflight=preflight,
                experiment_id=None if preflight else 64, source_bundle=BAD if preflight else None,
                items=[{"index": 1, "input_hash": "a" * 64, "byte_length": 100}])
            db = SimpleNamespace(scalar=AsyncMock(side_effect=[None, experiment]), add=Mock())
            with patch("cae.batches.serialize_events", AsyncMock()), patch("cae.batches.is_admin_user", return_value=False):
                with self.assertRaises(HTTPException) as error:
                    await create_batch(db, request, user, catalog)
            self.assert_path_error(error)
            db.add.assert_not_called()

    async def test_preexisting_staged_batch_cannot_bypass_guard_at_commit(self):
        batch = SimpleNamespace(id="batch", state="uploading", uploaded_count=1, total=1)
        experiment = SimpleNamespace(user_id="owner", source_hash="source", source_bundle=BAD)
        for preflight in (True, False):
            cae = SimpleNamespace(experiment_id=64, spec={"preflight": preflight, "source_bundle": BAD,
                "source_hash": "source", "catalog_revision": "catalog"})
            db = SimpleNamespace(get=AsyncMock(return_value=cae), scalar=AsyncMock(return_value=experiment), stream_scalars=AsyncMock())
            with patch("cae.uploads.serialize_events", AsyncMock()), patch("cae.uploads.require_batch", AsyncMock(return_value=batch)), patch("cae.uploads.is_admin_user", return_value=False):
                with self.assertRaises(HTTPException) as error:
                    await commit_batch(db, "batch", SimpleNamespace(id="owner"), SimpleNamespace(meta=lambda: {"catalogRevision": "catalog"}))
            self.assert_path_error(error)
            db.stream_scalars.assert_not_awaited()

    async def test_retry_cannot_execute_legacy_source(self):
        batch = SimpleNamespace(id="batch")
        job = SimpleNamespace(id="job", launcher_id=None, input={})
        cae = SimpleNamespace(experiment_id=64, spec={"source_hash": "source"})
        experiment = SimpleNamespace(source_hash="source", source_bundle=BAD)
        db = SimpleNamespace(scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: [job])),
            get=AsyncMock(return_value=cae), scalar=AsyncMock(return_value=experiment), commit=AsyncMock())
        with patch("cae.batches.serialize_events", AsyncMock()), patch("cae.batches.require_batch", AsyncMock(return_value=batch)):
            with self.assertRaises(HTTPException) as error:
                await retry_batch(db, "batch", "owner", None)
        self.assert_path_error(error)
        db.commit.assert_not_awaited()
