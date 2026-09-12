"""Synthetic lifecycle/storage checks; no database or Solver execution."""
import base64
import json
from datetime import timedelta
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from cae.models import BatchCreateRequest
from cae.preflight import expire_preflights, preflight_result, require_preflight_job
from cae.recording import complete_job, persist_record, stage_record, storage_packet
from gpstation.service.state import utcnow
from gpstation.service.batches import finish_job
from storage.service import bind_objects
from box_grid_fixtures import box_schema, box_tensor


class PreflightTests(unittest.IsolatedAsyncioTestCase):
    def job(self):
        return SimpleNamespace(id="11111111-1111-4111-8111-111111111111", user_id="owner", batch_id="batch",
            state="succeeded", attempt_count=1, finished_at=utcnow(), artifact_metadata={}, progress=[],
            input={"preflight": True, "storage_version": 1,
                "measurement": {"varsHash": "vars", "experiment": {"simulationProgram": {
                    "recordedData": {"field": box_schema()},
                    "resultContracts": {"field": {**box_tensor()["provenance"], "visualization": {"kind": "structured-field"}}},
                }}}})

    def test_request_rejects_saved_or_multi_candidate_preflight(self):
        request = dict(request_id="11111111-1111-4111-8111-111111111111", experiment_source_hash="source",
            mode="candidate", catalog_revision="catalog", builder_version="2", storage_version=1,
            preflight=True, source_bundle={"files": {"simulate.py": "pass"}},
            items=[{"index": 1, "input_hash": "a" * 64, "byte_length": 100}])
        with self.assertRaises(ValueError):
            BatchCreateRequest(**{**request, "execution_mode": "brief"})
        self.assertIsNone(BatchCreateRequest(**request).experiment_id)
        with self.assertRaises(ValueError):
            BatchCreateRequest(**{**request, "experiment_id": 1})
        with self.assertRaises(ValueError):
            BatchCreateRequest(**{**request, "items": request["items"] * 2})
        with self.assertRaises(ValueError):
            BatchCreateRequest(**{**request, "preflight": False})

    async def test_record_commit_and_result_without_measurement(self):
        job = self.job()
        value = box_tensor()
        db = SimpleNamespace(scalar=AsyncMock(return_value=None), get=AsyncMock(return_value=None),
            scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: [])), add=Mock(), flush=AsyncMock())
        await stage_record(db, job, {"sequence": 1, "name": "field", "value": value}, [])
        record = db.add.call_args.args[0]
        self.assertEqual(record.payload, value)
        # Include an object-backed tensor and actual coordinates in the same
        # completion, without downloading any bucket bytes.
        from gpstation.db import JobRecord, JobVisualization
        large_shape = (10000, 1, 1, 1, 1, 1, 1)
        large = {**box_tensor(large_shape), "storage": {"kind": "base64", "byteLength": 80000, "data": {
                "kind": "caemble.object", "version": 1, "id": job.id,
                "encoding": "base64", "sha256": "a" * 64, "byteLength": 80000}}}
        program = job.input["measurement"]["experiment"]["simulationProgram"]
        program["recordedData"]["large"] = box_schema(large_shape)
        program["resultContracts"]["large"] = {"visualization": {"kind": "tensor"}}
        staged = [record, JobRecord(job_id=job.id, attempt_count=1, sequence=2, name="large", payload=large)]
        db.scalars.side_effect = lambda statement: SimpleNamespace(all=lambda: [] if statement.column_descriptions[0]["entity"] is JobVisualization else list(staged))
        with patch("storage.service.bind_objects", AsyncMock()):
            result = await complete_job(db, job, {"recordSequences": [1, 2], "visualizationSequences": [], "executionTrace": []})
        self.assertEqual(result, {"preflight_id": "batch"})
        self.assertEqual(db.add.call_count, 1)  # Only JobRecord, never Measurement/RecordedData.
        expected = {"field": value, "large": large}
        async def delete_staging(statement):
            self.assertIn(statement.table.name, {"job_records", "job_visualizations"})
            self.assertEqual(job.artifact_metadata["recorded_data"], expected)
            staged.clear()
        db.execute = AsyncMock(side_effect=delete_staging)
        db.commit = AsyncMock()
        job.state = "finalizing"
        batch = SimpleNamespace(id="batch", state="running", succeeded=0, failed=0, cancelled=0, total=1)
        db.scalar.return_value = batch
        with patch("gpstation.service.batches.add_event", AsyncMock()):
            self.assertTrue(await finish_job(db, job, "succeeded", result=result))
        self.assertEqual(staged, [])
        self.assertEqual(batch.state, "completed")
        db.commit.assert_not_awaited()  # The worker connection commits both operations together.
        job.artifact_metadata = json.loads(json.dumps(job.artifact_metadata))
        db.scalars.reset_mock()
        cae = SimpleNamespace(spec={"preflight": True, "source_hash": "source", "source_bundle": {"files": {}}})
        db.get.side_effect = [cae, job]
        db.scalar.return_value = job.id
        with patch("cae.preflight.require_batch", AsyncMock(return_value=SimpleNamespace(id="batch"))):
            result = await preflight_result(db, "batch", "owner")
        self.assertEqual(result["recorded_data"], expected)
        db.scalars.assert_not_awaited()  # Never read the now-deleted staging records.
        self.assertEqual(result["result_contracts"], job.input["measurement"]["experiment"]["simulationProgram"]["resultContracts"])
        self.assertEqual(result["expires_at"], job.finished_at + timedelta(hours=24))

    async def test_previously_lost_snapshot_returns_explicit_error(self):
        job = self.job()
        cae = SimpleNamespace(spec={"preflight": True})
        db = SimpleNamespace(get=AsyncMock(side_effect=[cae, job]), scalar=AsyncMock(return_value=job.id))
        with patch("cae.preflight.require_batch", AsyncMock(return_value=SimpleNamespace(id="batch"))):
            with self.assertRaises(HTTPException) as error:
                await preflight_result(db, "batch", "owner")
        self.assertEqual(error.exception.status_code, 410)
        self.assertIn("유실", error.exception.detail)

    async def test_bucket_record_uses_job_ownership_and_preserves_binary(self):
        job = self.job()
        db = SimpleNamespace(scalar=AsyncMock(return_value=None))
        with patch("storage.service.prepare_upload", AsyncMock(return_value={"ready": False})) as prepare:
            await storage_packet(db, job, {"type": "job.storage.prepare", "manifest": {}})
        self.assertIsNone(prepare.call_args.kwargs["experiment_id"])
        self.assertEqual(prepare.call_args.kwargs["job_id"], job.id)
        raw = b"\x00" * 80000
        row = SimpleNamespace(id=job.id, user_id="owner", experiment_id=None, job_id=job.id, attempt=1,
            purpose="record", ready=True, bound=False, deleting=False, measurement_id=None,
            manifest={"encoding": "base64", "sha256": "a" * 64, "byteLength": len(raw), "chunks": []})
        from storage.service import reference
        ref = reference(row)
        db.scalar.return_value = row
        await bind_objects(db, ref, user_id="owner", experiment_id=None, job_id=job.id, attempt=1)
        self.assertTrue(row.bound)
        with self.assertRaises(HTTPException):
            await bind_objects(db, ref, user_id="owner", experiment_id=None, job_id="different", attempt=1)
        tensor = {"shape": [10000], "storage": {"kind": "base64", "data": ref, "byteLength": len(raw)}}
        self.assertEqual(persist_record({"dtype": "complex64"}, tensor, {}), tensor)
        attachment = {"shape": [10000], "storage": {"kind": "attachments", "ids": ["data"], "byteLength": len(raw)}}
        stored = persist_record({"dtype": "complex64"}, attachment, {"data": raw})
        self.assertEqual(base64.b64decode(stored["storage"]["data"]), raw)

    async def test_expiry_and_wrong_owner_block_reads_and_cleanup_payloads(self):
        job = self.job()
        db = SimpleNamespace(get=AsyncMock(return_value=job))
        job.artifact_metadata = {"recorded_data": {"field": {"storage": {"kind": "inline", "value": 1}}}}
        with self.assertRaises(HTTPException) as error:
            await require_preflight_job(db, job.id, "other")
        self.assertEqual(error.exception.status_code, 404)
        job.finished_at = utcnow() - timedelta(hours=25)
        with self.assertRaises(HTTPException) as error:
            await require_preflight_job(db, job.id, "owner")
        self.assertEqual(error.exception.status_code, 410)
        cae = SimpleNamespace(spec={"preflight": True, "source_bundle": {"files": {}}, "mode": "candidate"})
        db.get.return_value = cae
        db.scalars = AsyncMock(return_value=SimpleNamespace(all=lambda: [job]))
        db.execute, db.commit = AsyncMock(), AsyncMock()
        await expire_preflights(db)
        self.assertIsNone(job.input)
        self.assertIsNone(job.artifact_metadata)
        self.assertNotIn("source_bundle", cae.spec)
        self.assertEqual(db.execute.await_count, 3)  # Object tombstones plus both temporary result collections.
        db.commit.assert_awaited_once()
