import base64
import hashlib
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from models import CalculationDataOutput
from storage.contracts import ObjectReference
from storage.service import CHUNK_BYTES, bind_objects, finish_upload, object_refs, reference, signed_parts, validate_manifest
from cae.recording import persist_record


class ObjectStorageTests(unittest.IsolatedAsyncioTestCase):
    def row(self, data=b"test", encoding="base64"):
        digest = hashlib.sha256(data).hexdigest()
        return SimpleNamespace(id="11111111-1111-4111-8111-111111111111", user_id="owner", experiment_id=1,
            job_id="job", attempt=2, purpose="record", measurement_id=3, calculation_id=None,
            ready=False, bound=False, deleting=False,
            manifest={"sha256": digest, "byteLength": len(data), "encoding": encoding,
                      "chunks": [{"sha256": digest, "byteLength": len(data)}]})

    def test_manifest_requires_exact_chunks_and_valid_hashes(self):
        row = self.row()
        self.assertEqual(validate_manifest(row.manifest), row.manifest)
        for changed in ({"byteLength": True}, {"sha256": "g" * 64}, {"chunks": []}, {"byteLength": CHUNK_BYTES + 1}):
            with self.assertRaises(HTTPException):
                validate_manifest({**row.manifest, **changed})

    async def test_completion_uses_head_and_checks_real_s3_checksum(self):
        row = self.row()
        bucket = SimpleNamespace(head_object=lambda **kwargs: {"ContentLength": 4,
            "ChecksumSHA256": base64.b64encode(bytes.fromhex(row.manifest["sha256"])).decode()})
        with patch("storage.service.bucket_client", return_value=bucket):
            result = await finish_upload(None, row)
        self.assertTrue(result["ready"])
        row.ready = False
        bucket.head_object = lambda **kwargs: {"ContentLength": 4, "ChecksumSHA256": "wrong"}
        with patch("storage.service.bucket_client", return_value=bucket), self.assertRaises(HTTPException):
            await finish_upload(None, row)
        self.assertFalse(row.ready)

    async def test_binding_fences_attempt_owner_and_unfinished_upload(self):
        row = self.row()
        db = SimpleNamespace(scalar=AsyncMock(return_value=row))
        ref = reference(row)
        for owner, attempt in (("intruder", 2), ("owner", 1), ("owner", 2)):
            with self.assertRaises(HTTPException):
                await bind_objects(db, ref, user_id=owner, experiment_id=1, job_id="job", attempt=attempt)
        row.ready = True
        await bind_objects(db, ref, user_id="owner", experiment_id=1, job_id="job", attempt=2, bind=False)
        self.assertFalse(row.bound)
        await bind_objects(db, ref, user_id="owner", experiment_id=1, job_id="job", attempt=2)
        self.assertTrue(row.bound)

    def test_binary_record_preserves_shape_and_reference_without_reading_bytes(self):
        row = self.row(b"\x00" * 80000)
        value = {"shape": [10000], "storage": {"kind": "base64", "data": reference(row), "byteLength": 80000}}
        self.assertEqual(persist_record({"dtype": "float64"}, value, {}), value)
        with self.assertRaises(ValueError):
            persist_record({"dtype": "float32"}, value, {})
        self.assertEqual(list(object_refs(value)), [reference(row)])

    async def test_layout_reference_cannot_move_to_another_calculation(self):
        row = self.row()
        row.ready, row.purpose, row.measurement_id = True, "layout", None
        db = SimpleNamespace(scalar=AsyncMock(return_value=row))
        await bind_objects(db, reference(row), user_id="owner", experiment_id=1, calculation_id=9, purpose="layout")
        self.assertEqual(row.calculation_id, 9)
        self.assertTrue(row.bound)
        with self.assertRaises(HTTPException):
            await bind_objects(db, reference(row), user_id="owner", experiment_id=1, calculation_id=10, purpose="layout")

    def test_stored_calculation_requires_matching_layout_and_summary(self):
        row = self.row(b"[1,2]", "json")
        row.manifest["length"] = 2
        ref = reference(row)
        ObjectReference.model_validate(ref)
        output = {"dtype": "float64", "shape": [2], "data": ref,
                  "axes": [{"name": "x", "ticks": ref}],
                  "summary": {"kind": "tensor", "rank": 1, "count": 2, "mean": 1.5, "std": 0.707}}
        self.assertEqual(CalculationDataOutput.model_validate(output).data, ref)
        with self.assertRaises(ValueError):
            CalculationDataOutput.model_validate({**output, "summary": None})
        with self.assertRaises(ValueError):
            CalculationDataOutput.model_validate({**output, "shape": [3]})

    def test_presigned_put_is_conditional_and_checksum_bound(self):
        row = self.row()
        calls = []
        def sign(operation, **kwargs):
            calls.append((operation, kwargs))
            return "https://bucket.invalid/opaque"
        with patch("storage.service.bucket_client", return_value=SimpleNamespace(generate_presigned_url=sign)):
            parts = signed_parts(row, upload=True)
        self.assertEqual(calls[0][0], "put_object")
        self.assertEqual(calls[0][1]["Params"]["IfNoneMatch"], "*")
        self.assertEqual(parts[0]["headers"]["x-amz-checksum-sha256"], calls[0][1]["Params"]["ChecksumSHA256"])
