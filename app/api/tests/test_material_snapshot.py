from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import HTTPException
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from cae.models import BatchCreateRequest
from cae.uploads import validate_artifact_item
from db import Base, Measurement
from models import MeasurementCreateRequest, RoleEnum, UserData
from service.material_snapshot import material_vars_hash, validate_material_snapshot
from service.measurement_service import create_measurement


class MaterialSnapshotTests(unittest.IsolatedAsyncioTestCase):
    def snapshot(self, variables=None):
        return {
            "experiment": {"materials": {}}, "tasks": {}, "modelDefinitions": [],
            "selections": {}, "sourceHash": "a" * 64,
            "varsHash": material_vars_hash(variables or {}),
        }

    def artifact(self):
        snapshot = self.snapshot({"value": 7})
        return {"measurement": {
            "kind": "measurement", "materialSnapshot": snapshot["experiment"],
            "taskMaterialSnapshots": {}, "modelDefinitions": [], "materialSelections": {},
            "varsHash": snapshot["varsHash"],
            "experiment": {
                "sourceHash": snapshot["sourceHash"], "variables": {"value": 7},
                "varsSchema": {}, "scene": {}, "taskScenes": {},
                "simulationProgram": {"pythonSource": "async def simulate(*, sim, tasks, vars):\n    pass\n", "tasks": {}, "recordedData": {}},
            },
        }}

    def test_current_snapshot_upload_works_without_material_database(self):
        self.assertEqual(Measurement.__table__.c.material_snapshot.type.__class__.__name__, "JSONB")
        self.assertTrue({"materials", "material_names", "material_parameters", "material_parameter_qualifiers"}.isdisjoint(Base.metadata.tables))
        item = self.artifact()
        self.assertIs(validate_artifact_item(item, "a" * 64), item)

    def test_upload_rejects_changed_vars_and_legacy_material_fields(self):
        for mutate, message in (
            (lambda item: item["measurement"]["experiment"]["variables"].update(value=8), "varsHash"),
            (lambda item: item["measurement"].update(materialParameters={}), "Legacy Material"),
            (lambda item: item["measurement"].update(taskMaterialSnapshots={"task": {"materials": {}}}), "Task scenes"),
        ):
            item = self.artifact()
            mutate(item)
            with self.subTest(message=message), self.assertRaisesRegex(HTTPException, message):
                validate_artifact_item(item, "a" * 64)

    def test_snapshot_requires_captured_models_and_valid_selections(self):
        snapshot = self.snapshot()
        snapshot["experiment"]["materials"]["sample"] = {"models": {
            "response": {"model": "test.response@1", "parameters": {}},
        }}
        with self.assertRaisesRegex(ValueError, "models.response.model"):
            validate_material_snapshot(snapshot)
        snapshot["modelDefinitions"] = [{
            "key": "test.response@1", "labelKo": "Test", "description": "Test input",
            "equation": "", "conventions": "", "parameterSchema": {"kind": "object", "fields": {}},
        }]
        snapshot["tasks"] = {"task": {"materials": {}}}
        snapshot["selections"] = {"task": {"body": {"sample": {"response": "absent"}}}}
        with self.assertRaisesRegex(ValueError, "selections.task.body.sample.response"):
            validate_material_snapshot(snapshot)

    def test_material_names_cannot_conflict_across_task_scenes(self):
        snapshot = self.snapshot()
        snapshot["experiment"]["materials"] = {"sample": {"color": "#ff0000", "models": {}}}
        snapshot["tasks"] = {"task": {"materials": {"sample": {"color": "#0000ff", "models": {}}}}}
        snapshot["selections"] = {"task": {}}
        with self.assertRaisesRegex(ValueError, "conflicts"):
            validate_material_snapshot(snapshot)

    def test_vars_fingerprint_is_order_independent_preserves_shape_and_normalizes_negative_zero(self):
        self.assertEqual(material_vars_hash({}), "fnv1a64:09612b07b5ecb5a5")
        self.assertEqual(material_vars_hash({"x": -0.0, "y": [1, 2]}), material_vars_hash({"y": [1.0, 2.0], "x": 0}))
        self.assertNotEqual(material_vars_hash({"x": [[1], [2]]}), material_vars_hash({"x": [[1, 2]]}))
        for value in (float("nan"), float("inf"), True, 10**400):
            with self.subTest(value=value), self.assertRaises(ValueError):
                material_vars_hash({"x": value})

    def test_model_contracts_match_catalog_structurally_and_reject_incomplete_metadata(self):
        definition = {
            "key": "test.response@1", "labelKo": "Test", "description": "Test input",
            "equation": "", "conventions": "", "parameterSchema": {"kind": "object", "fields": {}},
        }
        snapshot = self.snapshot()
        snapshot["modelDefinitions"] = [dict(reversed(list(definition.items())))]
        snapshot["experiment"]["materials"] = {"sample": {"models": {"response": {"model": definition["key"], "parameters": {}}}}}
        catalog = SimpleNamespace(material_model=lambda key: definition)
        self.assertIs(validate_material_snapshot(snapshot, catalog=catalog), snapshot)
        snapshot["modelDefinitions"][0]["conventions"] = "Changed meaning"
        with self.assertRaisesRegex(ValueError, "differs from"):
            validate_material_snapshot(snapshot, catalog=catalog)
        del snapshot["modelDefinitions"][0]["equation"]
        with self.assertRaisesRegex(ValueError, "complete Model"):
            validate_material_snapshot(snapshot)

    def test_snapshot_does_not_capture_unused_model_definitions(self):
        snapshot = self.snapshot()
        snapshot["modelDefinitions"] = [{
            "key": "test.response@1", "labelKo": "Test", "description": "Test input",
            "equation": "", "conventions": "", "parameterSchema": {"kind": "object", "fields": {}},
        }]
        with self.assertRaisesRegex(ValueError, "exactly the models used"):
            validate_material_snapshot(snapshot)

    def test_snapshot_names_colors_and_malformed_schema_are_rejected(self):
        snapshot = self.snapshot()
        snapshot["experiment"]["materials"] = {"sample": {"color": "red", "models": {}}}
        with self.assertRaisesRegex(ValueError, "color"):
            validate_material_snapshot(snapshot)
        snapshot["experiment"]["materials"]["sample"] = {"models": {" response ": {}}}
        with self.assertRaisesRegex(ValueError, "trimmed instance"):
            validate_material_snapshot(snapshot)
        snapshot["experiment"]["materials"] = {}
        snapshot["modelDefinitions"] = [{
            "key": "test.response@1", "labelKo": "Test", "description": "Test input",
            "equation": "", "conventions": "", "parameterSchema": {"kind": "value", "dtype": []},
        }]
        with self.assertRaises(ValueError):
            validate_material_snapshot(snapshot)

    async def test_create_rejects_source_provenance_before_inserting_measurement(self):
        db = AsyncMock()
        db.scalar.return_value = SimpleNamespace(id=1, user_id="owner", source_hash="b" * 64)
        request = MeasurementCreateRequest(
            experiment_id=1, experiment_source_hash="a" * 64, vars={}, material_snapshot=self.snapshot(),
        )
        with self.assertRaises(HTTPException) as failure:
            await create_measurement(db, request, user=UserData(id="owner", roles=[RoleEnum.user]), catalog=SimpleNamespace())
        self.assertEqual(failure.exception.status_code, 409)
        db.flush.assert_not_awaited()
        db.commit.assert_not_awaited()
        db.scalar.return_value.source_hash = "a" * 64
        forged = copy.deepcopy(request)
        forged.material_snapshot["sourceHash"] = "b" * 64
        with self.assertRaisesRegex(ValueError, "sourceHash"):
            await create_measurement(db, forged, user=UserData(id="owner", roles=[RoleEnum.user]), catalog=SimpleNamespace())
        db.flush.assert_not_awaited()

    def test_legacy_measurement_create_and_builder_version_are_rejected(self):
        with self.assertRaises(ValidationError):
            MeasurementCreateRequest.model_validate({
                "experiment_id": 1, "experiment_source_hash": "a" * 64,
                "vars": {}, "material_parameters": {},
            })
        with self.assertRaises(ValidationError):
            BatchCreateRequest.model_validate({
                "request_id": "00000000-0000-0000-0000-000000000001", "experiment_id": 1,
                "experiment_source_hash": "a" * 64, "mode": "generate", "catalog_revision": "revision",
                "builder_version": "1", "items": [{"index": 1, "input_hash": "b" * 64, "byte_length": 1}],
            })


if __name__ == "__main__":
    unittest.main()
