import copy
import hashlib
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException

from box_grid_fixtures import box_schema, box_tensor
from cae.db import CaeBatch
from cae.recording import complete_job, persist_record, stage_record, stage_visualization
from db import Experiment, ExperimentRecord, MeasurementVisualization
from gpstation.db import JobRecord, JobVisualization
from models import CalculationBase, RoleEnum, UserData
from service.box_grid import validate_box_grid_schema, validate_box_grid_tensor
from service.calculation import upsert_calculations
from service.measurement_service import get_recorded_data, get_visualizations


class BoxGridResultTests(unittest.IsolatedAsyncioTestCase):
    def test_rejects_legacy_and_malformed_numerical_results(self):
        schema, tensor = box_schema(), box_tensor()
        validate_box_grid_tensor(schema, tensor)
        for changed in ({"dtype": "complex64"}, {"dtype": "float16"}, {"axes": schema["axes"] + [{}]}, {"boxGrid": {}}, {"boxGrid": tensor["boxGrid"]}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                validate_box_grid_schema({**schema, **changed})
        for changed in ({"shape": [2, 1, 1, 1, 1, 1, 2]}, {"boxGrid": {**tensor["boxGrid"], "gridShape": [1, 1, 1]}}, {"boxGrid": {**tensor["boxGrid"], "rotation": [[1, 0, 0]] * 3}}, {"provenance": None}, {"provenance": {**tensor["provenance"], "invocation": 0}}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                validate_box_grid_tensor(schema, {**tensor, **changed})

    def test_persistence_keeps_candidate_geometry_and_polar_channel_units(self):
        tensor = box_tensor()
        self.assertEqual(persist_record(box_schema(), tensor, {}), tensor)
        schema = box_schema((2, 1, 1, 1, 1, 2, 1))
        schema["boxGrid"].update(channels=["amplitude", "phase"], channelUnits=["1", "rad"])
        validate_box_grid_schema(schema)
        schema["boxGrid"]["channelUnits"][1] = "deg"
        with self.assertRaisesRegex(ValueError, "radians"):
            validate_box_grid_schema(schema)

    def fixture(self):
        visual_schema = {"vertices": {"dtype": "float32", "axes": [{}, {"length": 3}]}}
        visual_contract = {"artifactType": "fixture.paths@1", "visualization": {"kind": "polyline", "vertices": "vertices", "offsets": "offsets"}}
        item = {"contract": visual_contract, "schema": visual_schema,
            "data": {"vertices": {"shape": [1, 3], "storage": {"kind": "inline", "value": [[0, 0, 0]]}}},
            "provenance": {"task": "solver", "solver": {"name": "fixture", "version": "1.0.0"}, "stateRevision": 1, "invocation": 2, "catalogRevision": "revision"}}
        job = SimpleNamespace(id="job", user_id="owner", attempt_count=1, batch_id="batch", artifact_metadata={},
            input={"preflight": True, "measurement": {"experiment": {"simulationProgram": {
                "tasks": {"solver": {"kernel": item["provenance"]["solver"]}}, "recordedData": {"field": box_schema()},
                "resultContracts": {"field": box_tensor()["provenance"]},
                "visualizationContracts": {"solver": {"paths": {**visual_contract, "schema": visual_schema}}},
            }}}})
        records, visuals = [], []
        def scalar_rows(statement):
            entity = statement.column_descriptions[0]["entity"]
            rows = visuals if entity is JobVisualization else records
            whole = statement.column_descriptions[0]["expr"] is entity
            return SimpleNamespace(all=lambda: list(rows) if whole else [row.sequence for row in rows])
        async def get_row(entity, identity):
            if entity is CaeBatch:
                return SimpleNamespace(spec={"catalog_revision": "revision"}) if identity == job.batch_id else None
            return next((row for row in (visuals if entity is JobVisualization else records) if row.sequence == identity[2]), None)
        def add(row):
            (visuals if isinstance(row, JobVisualization) else records).append(row)
        db = SimpleNamespace(scalars=AsyncMock(side_effect=scalar_rows), scalar=AsyncMock(return_value=None),
            get=AsyncMock(side_effect=get_row), add=Mock(side_effect=add), flush=AsyncMock())
        return job, item, db, records, visuals

    async def test_visualization_protocol_is_separate_idempotent_and_atomic(self):
        job, item, db, records, visuals = self.fixture()
        await stage_record(db, job, {"sequence": 1, "name": "field", "value": box_tensor()}, [])
        packet = {"sequence": 2, "task": "solver", "visualizations": {"paths": item}}
        await stage_visualization(db, job, packet, [])
        await stage_visualization(db, job, packet, [])
        self.assertEqual(len(visuals), 1)
        changed = copy.deepcopy(packet)
        changed["visualizations"]["paths"]["data"]["vertices"]["storage"]["value"][0][0] = 1
        with self.assertRaisesRegex(ValueError, "different contents"):
            await stage_visualization(db, job, changed, [])
        with patch("storage.service.bind_objects", AsyncMock()):
            await complete_job(db, job, {"recordSequences": [1], "visualizationSequences": [2]})
        self.assertEqual(set(job.artifact_metadata["recorded_data"]), {"field"})
        self.assertEqual(job.artifact_metadata["recorded_data"]["field"], box_tensor())
        self.assertEqual(job.artifact_metadata["visualizations"], {"solver": {"paths": item}})
        self.assertEqual(len(records), 1)
        with self.assertRaisesRegex(ValueError, "Terminal visualizations"):
            await complete_job(db, job, {"recordSequences": [1], "visualizationSequences": []})

    async def test_wrong_task_or_visual_contract_is_rejected(self):
        job, item, db, _, _ = self.fixture()
        packet = {"sequence": 1, "task": "solver", "visualizations": {"paths": item}}
        item["contract"] = {**item["contract"], "artifactType": "wrong@1"}
        with self.assertRaisesRegex(ValueError, "frozen contract"):
            await stage_visualization(db, job, packet, [])
        with self.assertRaisesRegex(ValueError, "Invalid visualization identity"):
            await stage_visualization(db, job, {**packet, "task": "unknown"}, [])
        with self.assertRaisesRegex(ValueError, "seven"):
            await stage_record(db, job, {"sequence": 1, "name": "field", "value": {"shape": [2], "storage": {"kind": "inline", "value": [1, 2]}}}, [])

    async def test_analysis_specific_visualization_subset_is_valid(self):
        job, item, db, _, visuals = self.fixture()
        frozen = job.input["measurement"]["experiment"]["simulationProgram"]["visualizationContracts"]["solver"]
        frozen["transientHistory"] = copy.deepcopy(frozen["paths"])
        await stage_visualization(db, job, {"sequence": 1, "task": "solver", "visualizations": {"paths": item}}, [])
        self.assertEqual(visuals[0].payload, {"paths": item})
        with self.assertRaisesRegex(ValueError, "frozen Task"):
            await stage_visualization(db, job, {"sequence": 2, "task": "solver", "visualizations": {"unknown": item}}, [])

    async def test_visual_only_job_requires_its_batch_catalog_revision(self):
        job, item, db, records, visuals = self.fixture()
        program = job.input["measurement"]["experiment"]["simulationProgram"]
        program["recordedData"] = {}
        program["resultContracts"] = {}
        item["provenance"]["catalogRevision"] = "different-revision"
        packet = {"sequence": 1, "task": "solver", "visualizations": {"paths": item}}
        with self.assertRaisesRegex(ValueError, "frozen Catalog revision"):
            await stage_visualization(db, job, packet, [])
        self.assertEqual(visuals, [])
        item["provenance"]["catalogRevision"] = "revision"
        await stage_visualization(db, job, packet, [])
        with patch("storage.service.bind_objects", AsyncMock()):
            await complete_job(db, job, {"recordSequences": [], "visualizationSequences": [1]})
        self.assertEqual(records, [])
        self.assertEqual(job.artifact_metadata["recorded_data"], {})
        self.assertEqual(job.artifact_metadata["visualizations"], {"solver": {"paths": item}})

    async def test_empty_visualization_packet_still_requires_a_frozen_batch_revision(self):
        for batch in (None, SimpleNamespace(spec={}), SimpleNamespace(spec={"catalog_revision": ""})):
            job, _, db, _, visuals = self.fixture()
            db.get = AsyncMock(return_value=batch)
            with self.subTest(batch=batch), self.assertRaisesRegex(ValueError, "frozen Batch Catalog revision"):
                await stage_visualization(db, job, {"sequence": 1, "task": "solver", "visualizations": {}}, [])
            self.assertEqual(visuals, [])

    async def test_visualization_read_has_experiment_visibility(self):
        db = SimpleNamespace(get=AsyncMock(return_value=SimpleNamespace(experiment_id=7)),
            scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: [MeasurementVisualization(measurement_id=1, task="solver", data={"mesh": {"data": {}}})])))
        with patch("service.measurement_service.require_experiment_read", AsyncMock()):
            response = await get_visualizations(db, 1, user=None)
        self.assertEqual(response.visualizations, {"solver": {"mesh": {"data": {}}}})
        with patch("service.measurement_service.require_experiment_read", AsyncMock(side_effect=HTTPException(403))):
            with self.assertRaises(LookupError):
                await get_visualizations(db, 1, user=None)

    async def test_numerical_read_preserves_box_geometry_and_originating_call(self):
        tensor, schema = box_tensor(), box_schema()
        record = ExperimentRecord(id=2, name="field", quantity_kind="Dimensionless", tensor_order=0, dtype="float64", data_schema=schema)
        db = SimpleNamespace(get=AsyncMock(side_effect=[SimpleNamespace(experiment_id=7), SimpleNamespace(result_contracts={})]),
            execute=AsyncMock(return_value=SimpleNamespace(all=lambda: [(SimpleNamespace(data=tensor), record)])))
        with patch("service.measurement_service.require_experiment_read", AsyncMock()):
            response = await get_recorded_data(db, 1, user=None)
        leaf = response.model_dump()["recorded_data"]["field"]
        self.assertEqual(leaf["data_schema"]["boxGrid"], schema["boxGrid"])
        self.assertEqual(leaf["data"], tensor)

    async def test_numerical_provenance_must_match_its_frozen_contract(self):
        job, _, db, _, _ = self.fixture()
        for key, changed in (("task", "foreign"), ("solver", {"name": "foreign", "version": "1.0.0"}), ("catalogRevision", "different")):
            tensor = box_tensor()
            tensor["provenance"][key] = changed
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "provenance differs"):
                await stage_record(db, job, {"sequence": 1, "name": "field", "value": tensor}, [])

    async def test_calculation_cannot_bind_a_legacy_record(self):
        source = "export default () => 1"
        item = CalculationBase(experiment_id=1, name="sum", source_code=source,
            source_hash=hashlib.sha256(source.encode()).hexdigest(), contract_status="ready",
            output_layout={"dtype": "float64", "shape": [], "axes": []}, preflight_measurement_id=1,
            experiment_record_ids=[2])
        db = SimpleNamespace(scalars=AsyncMock(side_effect=[
            SimpleNamespace(all=lambda: [Experiment(id=1, user_id="owner")]),
            SimpleNamespace(all=lambda: [ExperimentRecord(id=2, experiment_id=1, data_schema={"dtype": "float64"})]),
        ]))
        with self.assertRaises(HTTPException) as error:
            await upsert_calculations(db, [item], user=UserData(id="owner", roles=[RoleEnum.user]))
        self.assertEqual(error.exception.status_code, 422)
        self.assertIn("Box Grid", error.exception.detail)
