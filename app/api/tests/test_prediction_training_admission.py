"""Manual rebuilds freeze a checked base while legacy inference remains readable."""
from copy import deepcopy
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

from fastapi import HTTPException

from prediction.common import digest
from prediction.db import Dataset, DatasetRevision, ModelRevision, Operation, PredictionModel
from prediction.models import reserve_model
from prediction.schemas import ModelReserve
from prediction_contracts import QUALITY_VALIDATION_V1, QUALITY_VALIDATION_V2


class ManualTrainingAdmissionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.owner = str(uuid4())
        self.model = SimpleNamespace(id=str(uuid4()), user_id=self.owner, direction="forward", current_revision=1,
            experiment_id=3, name="Saved model")
        self.dataset = SimpleNamespace(id=str(uuid4()), source_kind="server", experiment_id=3)
        self.target = SimpleNamespace(fingerprint="snapshot-2", payload={}, summary={"source_contracts": {}})
        self.definition = {"algorithm": {"kind": "knn"}, "implementationVersion": "knn-v1",
            "preprocessingVersion": "box-relative-v2", "qualityValidation": deepcopy(QUALITY_VALIDATION_V2),
            "snapshotFingerprint": "snapshot-2", "fingerprint": "definition-2"}
        self.base = SimpleNamespace(revision=1, state="ready", definition={**self.definition,
            "snapshotFingerprint": "snapshot-1"}, artifact={"manifest_sha256": "a" * 64},
            dataset_id=self.dataset.id, dataset_revision=1, dataset_fingerprint="snapshot-1")
        self.body = ModelReserve(request_id=uuid4(), model_id=self.model.id, expected_revision=1,
            name="Rebuilt model", dataset_id=self.dataset.id, dataset_revision=2, definition=self.definition,
            storage_id=uuid4(), launcher_id=uuid4())
        self.copy = SimpleNamespace(id=str(uuid4()))
        self.changes = {"baseSnapshot": {"datasetId": self.dataset.id, "revision": 1, "fingerprint": "snapshot-1"},
            "targetSnapshot": {"datasetId": self.dataset.id, "revision": 2, "fingerprint": "snapshot-2"},
            "added": [6], "changed": [], "removed": []}
        async def get(kind, key):
            return {PredictionModel: self.model, DatasetRevision: self.target, ModelRevision: self.base}.get(kind)
        async def owned(db, kind, key, owner):
            return self.dataset if kind is Dataset else self.model
        self.db = SimpleNamespace(get=AsyncMock(side_effect=get), scalar=AsyncMock(side_effect=[None, None, self.copy, 1]),
            scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: [])), add=Mock(), flush=AsyncMock(), commit=AsyncMock())
        for target, value in {
            "gpstation.service.batches.serialize_events": AsyncMock(),
            "prediction.models.lock_identity": AsyncMock(), "prediction.models.owned": AsyncMock(side_effect=owned),
            "prediction.models.connected_storage": AsyncMock(),
            "prediction.training.assert_model_update_available": AsyncMock(),
            "optimization.guards.require_training_continuation": AsyncMock(),
            "prediction.models.dataset_change_set": AsyncMock(return_value=self.changes),
            "prediction.models.validate_update_references": AsyncMock(),
            "prediction.models.model_view": AsyncMock(return_value={"id": self.model.id}),
            "prediction.training.create_run": AsyncMock(),
            "prediction.training.operation_view": AsyncMock(return_value={"training": {}}),
        }.items():
            active = patch(target, value)
            active.start()
            self.addCleanup(active.stop)
        from prediction.models import validate_update_references
        self.validate_references = validate_update_references

    async def test_manual_revision_without_update_freezes_exact_rebuild_and_original_request_hash(self):
        original = self.body.model_dump(mode="json")
        result = await reserve_model(self.db, self.body, self.owner)
        revision = next(call.args[0] for call in self.db.add.call_args_list if isinstance(call.args[0], ModelRevision))
        update = revision.preparation["training_update"]
        self.assertEqual(update, {"mode": "rebuild", "baseModel": {"modelId": self.model.id, "revision": 1,
            "checksum": "a" * 64, "storageId": str(self.body.storage_id), "replicaId": self.copy.id},
            "targetSnapshot": self.changes["targetSnapshot"], "changeSet": self.changes,
            "recipe": {key: value for key, value in self.definition.items() if key not in {"fingerprint", "snapshotFingerprint"}}})
        self.assertEqual(self.validate_references.await_args.args[1], update)
        operation = next(call.args[0] for call in self.db.add.call_args_list if isinstance(call.args[0], Operation))
        self.assertEqual(operation.details["update"], update)
        expected_hash = {key: value for key, value in original.items() if key != "dataset_source"}
        self.assertEqual(revision.request_hash, digest(expected_hash))
        self.assertEqual(result["reserved_revision"], 2)
        self.assertEqual(self.body.model_dump(mode="json"), original)
        self.model.current_revision = 3
        self.db.scalar.side_effect = [revision]
        self.db.add.reset_mock()
        self.validate_references.reset_mock()
        replay = await reserve_model(self.db, self.body, self.owner)
        self.assertEqual(replay["reserved_revision"], 2)
        self.validate_references.assert_not_awaited()
        self.db.add.assert_not_called()

    async def test_legacy_parent_requires_a_fresh_model_before_any_new_revision(self):
        for settings in (None, QUALITY_VALIDATION_V1):
            with self.subTest(settings=settings):
                self.base.definition = {**self.definition, "qualityValidation": settings}
                self.db.scalar.side_effect = [None, None]
                with self.assertRaises(HTTPException) as rejected:
                    await reserve_model(self.db, self.body, self.owner)
                self.assertEqual(rejected.exception.status_code, 409)
                self.assertIn("create a fresh model", rejected.exception.detail)
        self.db.add.assert_not_called()
        self.db.commit.assert_not_awaited()

    async def test_missing_or_changed_base_copy_requires_restoration(self):
        self.db.scalar.side_effect = [None, None, None]
        with self.assertRaises(HTTPException) as rejected:
            await reserve_model(self.db, self.body, self.owner)
        self.assertEqual(rejected.exception.status_code, 409)
        self.assertIn("Restore the exact base model", rejected.exception.detail)
        self.db.add.assert_not_called()

    async def test_missing_quality_cannot_be_bypassed_by_manual_revision(self):
        for algorithm in ("knn", "mlp"):
            with self.subTest(algorithm=algorithm):
                definition = {**self.definition, "algorithm": {"kind": algorithm}, "implementationVersion": f"{algorithm}-v1"}
                definition.pop("qualityValidation")
                body = self.body.model_copy(update={"definition": definition})
                self.db.scalar.side_effect = [None, None]
                with self.assertRaises(HTTPException) as rejected:
                    await reserve_model(self.db, body, self.owner)
                self.assertEqual(rejected.exception.status_code, 422)
                self.assertIn("version 2", rejected.exception.detail)
        self.db.add.assert_not_called()
