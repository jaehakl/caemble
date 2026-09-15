"""Particle tensor persistence/requery through the existing API channels; no live DB."""
import base64
import copy
import json
from pathlib import Path
import struct
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from cae.db import CaeBatch
from cae.preflight import preflight_result
from cae.recording import complete_job, stage_visualization
from gpstation.db import JobVisualization
from gpstation.service.state import utcnow
from service.measurement_service import get_visualizations


class ParticleVisualizationTests(unittest.IsolatedAsyncioTestCase):
    async def test_particle_attachment_and_metadata_survive_completion_and_both_read_paths(self):
        times, ids = list(range(1500)), [90, 2]
        axes = [{"ticks": times}, {"ticks": ids}, {"ticks": ["x", "y", "z"]}]
        raw = struct.pack("<9000d", *range(9000))
        schema = {
            "positions": {"dtype": "float64", "quantityKind": "Length", "unit": "m",
                          "axes": [{"name": "time", "quantityKind": "Time", "unit": "s"}, {"name": "particle"}, {"length": 3}]},
            "particleIds": {"dtype": "int32", "axes": [{"name": "particle"}]},
            "materialIndices": {"dtype": "int32", "axes": [{"name": "particle"}]},
            "materialNames": {"dtype": "string", "axes": [{"name": "material"}]},
            "times": {"dtype": "float64", "quantityKind": "Time", "unit": "s", "axes": [{"name": "time"}]},
        }
        schema["velocity"] = {**schema["positions"], "quantityKind": "kinematics.Velocity", "unit": "m.s-1"}
        def inline(value, shape):
            return {"shape": shape, "storage": {"kind": "inline", "value": value}}
        data = {
            "positions": {"shape": [1500, 2, 3], "axes": axes,
                          "storage": {"kind": "attachments", "ids": ["positions"], "byteLength": len(raw)}},
            "particleIds": inline(ids, [2]), "materialIndices": inline([1, 0], [2]),
            "materialNames": inline(["Water", "Steel"], [2]), "times": inline(times, [1500]),
        }
        data["velocity"] = copy.deepcopy(data["positions"])
        contract = {"artifactType": "caemble.sph/particle-history@1", "visualization": {
            "kind": "particle-set", "coordinateSpace": "experiment", "particleSet": {
                "positions": "positions", "particleIds": "particleIds", "materialIndices": "materialIndices",
                "materialNames": "materialNames", "times": "times", "attributes": {"velocity": {"path": "velocity", "components": ["x", "y", "z"]}},
            },
        }}
        solver = {"name": "sph", "version": "1.0.0"}
        entry = {"contract": contract, "schema": schema, "data": data, "provenance": {
            "task": "fluid", "solver": solver, "stateRevision": 2, "invocation": 2, "catalogRevision": "particle-catalog",
        }}
        program = {"tasks": {"fluid": {"kernel": solver}}, "visualizationContracts": {"fluid": {"particles": {**contract, "schema": schema}}},
                   "recordedData": {}, "resultContracts": {}}
        job = SimpleNamespace(id="11111111-1111-4111-8111-111111111111", batch_id="batch", user_id="owner", attempt_count=1,
            state="succeeded", finished_at=utcnow(), artifact_metadata={},
            input={"preflight": True, "measurement": {"varsHash": "vars", "experiment": {"simulationProgram": program}}})
        batch = SimpleNamespace(spec={"catalog_revision": "particle-catalog", "preflight": True, "source_hash": "source", "source_bundle": {"files": {}}})
        db = SimpleNamespace(get=AsyncMock(side_effect=lambda entity, _: batch if entity is CaeBatch else None),
            scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: [])), scalar=AsyncMock(), add=Mock(), flush=AsyncMock())
        await stage_visualization(db, job, {"sequence": 1, "task": "fluid", "visualizations": {"particles": entry}},
                                  [SimpleNamespace(id="positions", data=raw)])
        staged = db.add.call_args.args[0]
        db.scalars.side_effect = lambda statement: SimpleNamespace(all=lambda: [staged] if statement.column_descriptions[0]["entity"] is JobVisualization else [])
        with patch("storage.service.bind_objects", AsyncMock()):
            await complete_job(db, job, {"recordSequences": [], "visualizationSequences": [1], "executionTrace": []})
        job.artifact_metadata = json.loads(json.dumps(job.artifact_metadata))
        db.get.side_effect = [batch, job]
        db.scalar.return_value = job.id
        with patch("cae.preflight.require_batch", AsyncMock(return_value=SimpleNamespace(id="batch"))):
            fetched = await preflight_result(db, "batch", "owner")
        result = fetched["visualizations"]["fluid"]["particles"]
        self.assertEqual(result["contract"], contract)
        self.assertEqual(result["schema"], schema)
        self.assertEqual(result["provenance"], entry["provenance"])
        self.assertEqual(result["data"]["positions"]["axes"], axes)
        self.assertEqual(result["schema"]["velocity"]["quantityKind"], "kinematics.Velocity")
        self.assertEqual(result["schema"]["velocity"]["unit"], "m.s-1")
        self.assertEqual(base64.b64decode(result["data"]["positions"]["storage"]["data"]), raw)
        self.assertEqual(result["data"]["particleIds"]["storage"]["value"], ids)
        self.assertEqual(result["data"]["materialIndices"]["storage"]["value"], [1, 0])
        self.assertEqual(result["data"]["materialNames"]["storage"]["value"], ["Water", "Steel"])
        db.get.side_effect = None
        db.get.return_value = SimpleNamespace(experiment_id=7)
        db.scalars.side_effect = None
        db.scalars.return_value = SimpleNamespace(all=lambda: [SimpleNamespace(task="fluid", data={"particles": result})])
        with patch("service.measurement_service.require_experiment_read", AsyncMock()):
            measured = await get_visualizations(db, 5, user=None)
        self.assertEqual(measured.visualizations, fetched["visualizations"])
        bad = copy.deepcopy(entry)
        bad["provenance"]["catalogRevision"] = "different"
        db.get.return_value = batch
        with self.assertRaisesRegex(ValueError, "Catalog revision"):
            await stage_visualization(db, job, {"sequence": 1, "task": "fluid", "visualizations": {"particles": bad}}, [])
