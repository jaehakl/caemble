import base64
import copy
import hashlib
import json
import struct
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from caemble_catalog import open_catalog

from box_grid_fixtures import box_schema, box_tensor
from cae.db import CaeBatch
from cae.recording import complete_job, persist_record, stage_record, stage_visualization
from db import Experiment, ExperimentRecord, MeasurementVisualization
from gpstation.db import JobRecord, JobVisualization
from models import CalculationBase, RoleEnum, UserData
from service.box_grid import validate_box_grid_schema, validate_box_grid_tensor
from service.calculation import upsert_calculations
from service.data_tools import VisibleDataReader
from service.measurement_service import get_recorded_data, get_visualizations


class BoxGridResultTests(unittest.IsolatedAsyncioTestCase):
    def test_surface_power_preserves_sampling_frequency_and_geometry_after_storage(self):
        with open_catalog() as catalog:
            output = next(item for item in catalog.get_solver_manifest('ray-tracing', '5.1.0')['descriptor']['methods']['outputs']
                          if item['methodId'] == 'ray.detector-power')
        schema = output['data']
        tensor = box_tensor((2, 1, 1, 1, 1, 1, 1))
        tensor['boxGrid'].update(schema['boxGrid'])
        tensor['axes'][-2:] = [{'ticks':['value']},{'ticks':['value']}]
        tensor['axes'][4] = {'ticks':[5e14], 'unit':'Hz'}
        tensor['storage'] = {'kind':'attachments','ids':['power'],'byteLength':16}
        saved = persist_record(schema, tensor, {'power':struct.pack('<dd',2.,3.)})
        queried = json.loads(json.dumps(saved))
        validate_box_grid_tensor(schema, queried)
        self.assertEqual(queried['boxGrid'], tensor['boxGrid'])
        self.assertEqual(queried['axes'], tensor['axes'])
        self.assertEqual(queried['provenance'], tensor['provenance'])
        changed = copy.deepcopy(queried)
        changed['boxGrid']['sampling'] = 'cell-average'
        with self.assertRaises(ValueError):
            validate_box_grid_tensor(schema, changed)

    async def test_candidate_result_metadata_survives_storage_and_requery(self):
        metadata_schema = {
            "pressureOffset": {"dtype": "float64", "quantityKind": "Pressure", "unit": "Pa"},
            "momentOrigin": {"dtype": "float64", "quantityKind": "Length", "unit": "m", "shape": [3]},
            "surfaceTargets": {"dtype": "string", "shape": [None]},
            "contribution": {"dtype": "string", "values": ["total", "pressure", "viscous"]},
        }
        for count in (2, 10000):
            with self.subTest(count=count):
                schema, tensor = box_schema((count, 1, 1, 1, 1, 1, 1)), box_tensor((count, 1, 1, 1, 1, 1, 1))
                schema["metadata"] = metadata_schema
                tensor["metadata"] = {"pressureOffset": -12., "momentOrigin": [0.2, 0.3, 1.], "surfaceTargets": ["experiment.surface.wall"], "contribution": "total"}
                raw = struct.pack(f"<{count}d", *([-4.] * count))
                tensor["storage"] = {"kind": "attachments", "ids": ["values"], "byteLength": len(raw)}
                saved = persist_record(schema, tensor, {"values": raw})
                validate_box_grid_tensor(schema, saved)
                record = ExperimentRecord(id=2, name="load", quantity_kind="Dimensionless", tensor_order=0, dtype="float64", data_schema=schema)
                db = SimpleNamespace(get=AsyncMock(side_effect=[SimpleNamespace(experiment_id=7), SimpleNamespace(result_contracts={})]),
                    execute=AsyncMock(return_value=SimpleNamespace(all=lambda: [(SimpleNamespace(data=saved), record)])))
                with patch("service.measurement_service.require_experiment_read", AsyncMock()):
                    response = await get_recorded_data(db, 1, user=None)
                leaf = response.model_dump()["recorded_data"]["load"]
                self.assertEqual(leaf["data"]["metadata"], tensor["metadata"])
                self.assertEqual(leaf["data_schema"]["metadata"], metadata_schema)
                reader = VisibleDataReader(AsyncMock(), "owner")
                with patch.object(reader, "_recorded_row", AsyncMock(return_value={
                    "id": 2, "name": "load", "dtype": "float64", "quantity_kind": "Dimensionless",
                    "data_schema": schema, "data": saved,
                })):
                    sliced = await reader.read_recorded_slice(2, 1, 1)
                self.assertEqual(sliced["values"], [-4.])
                self.assertEqual(sliced["dataSchema"]["metadata"], metadata_schema)
                for key in ("axes", "boxGrid", "metadata"):
                    self.assertEqual(sliced[key], tensor[key])
                self.assertEqual(sliced["resultProvenance"], tensor["provenance"])
                self.assertEqual(sliced["provenance"]["kind"], "database")
                for broken in ({}, {**tensor["metadata"], "pressureOffset": float("nan")},
                               {**tensor["metadata"], "momentOrigin": [0, 0]}, {**tensor["metadata"], "extra": 1}):
                    with self.assertRaises(ValueError):
                        validate_box_grid_tensor(schema, {**saved, "metadata": broken})

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

    def test_attachment_backed_configuration_and_weighting_survive_persistence(self):
        tensor, schema = box_tensor(), box_schema()
        for metadata in (schema["boxGrid"], tensor["boxGrid"]):
            metadata.update(configuration="reference", weighting="material-volume")
        tensor["storage"] = {"kind": "attachments", "ids": ["values"], "byteLength": 16}
        restored = persist_record(schema, tensor, {"values": struct.pack("<dd", 1., 2.)})
        self.assertEqual(restored["boxGrid"], tensor["boxGrid"])
        self.assertEqual(restored["shape"], tensor["shape"])
        changed = copy.deepcopy(tensor)
        changed["boxGrid"]["configuration"] = "current"
        with self.assertRaisesRegex(ValueError, "metadata differs"):
            validate_box_grid_tensor(schema, changed)

    def test_sph_pressure_and_density_preserve_values_and_meaning_after_attachment_storage(self):
        with open_catalog() as catalog:
            outputs = catalog.get_solver_manifest("sph", "1.1.0")["descriptor"]["methods"]["outputs"]
        restored = {}
        for method, values in (("sph.pressure", (-20., 0., 0.)), ("sph.mass-density", (8., 3., 0.))):
            values = values * 3000  # Keep persisted values above the inline threshold.
            schema = next(item["data"] for item in outputs if item["methodId"] == method)
            tensor = box_tensor((len(values), 1, 1, 1, 1, 1, 1))
            tensor["boxGrid"] = {**tensor["boxGrid"], **schema["boxGrid"]}
            tensor["axes"][-2:] = [{"ticks": ["value"]}, {"ticks": ["value"]}]
            raw = struct.pack(f"<{len(values)}d", *values)
            tensor["storage"] = {"kind": "attachments", "ids": ["values"], "byteLength": len(raw)}
            saved = persist_record(schema, tensor, {"values": raw})
            queried = json.loads(json.dumps(saved))
            validate_box_grid_tensor(schema, queried)
            restored[method] = struct.unpack(f"<{len(values)}d", base64.b64decode(queried["storage"]["data"]))
            self.assertEqual(restored[method], values)
            self.assertEqual(queried["boxGrid"], tensor["boxGrid"])
            self.assertEqual(queried["axes"], tensor["axes"])
        self.assertEqual([value > 0 for value in restored["sph.mass-density"][:3]], [True, True, False])

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
        for metadata in (schema["boxGrid"], tensor["boxGrid"]):
            metadata.update(configuration="current", weighting="material-volume")
        self.assertEqual(persist_record(schema, tensor, {}), tensor)
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
