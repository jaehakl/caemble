"""Native mixed-field semantics survive inline/binary API persistence and reread."""

import base64
import json
import struct
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from cae.recording import stage_visualization
from cae.db import CaeBatch
from service.measurement_service import get_visualizations


class MixedVisualizationTests(unittest.IsolatedAsyncioTestCase):
    async def test_mean_pressure_averaging_units_and_sign_survive_recording(self):
        for count in (2, 10000):
            with self.subTest(count=count):
                schema = {"values": {"dtype": "float64", "quantityKind": "Pressure", "unit": "Pa", "axes": [{"name": "cell"}]}}
                values = [125.0] * count
                raw = struct.pack(f"<{count}d", *values)
                storage = ({"kind": "inline", "value": values} if count == 2 else
                           {"kind": "attachments", "ids": ["pressure"], "byteLength": len(raw)})
                contract = {"artifactType": "caemble.structural/mean-pressure@1", "visualization": {
                    "kind": "mesh-field", "valuePath": "values", "components": ["meanPressure"],
                    "valueKind": "scalar", "configuration": "reference", "sampling": "cell-average",
                    "weighting": "reference-volume", "signConvention": "compression-positive",
                }}
                solver = {"name": "structural-mechanics", "version": "7.1.0"}
                entry = {"contract": contract, "schema": schema, "data": {"values": {"shape": [count], "storage": storage}},
                         "provenance": {"task": "solid", "solver": solver, "stateRevision": 0, "invocation": 1, "catalogRevision": "mixed-catalog"}}
                program = {"tasks": {"solid": {"kernel": solver}}, "visualizationContracts": {"solid": {"meanPressure": {**contract, "schema": schema}}}}
                job = SimpleNamespace(id="11111111-1111-4111-8111-111111111111", batch_id="batch", attempt_count=1,
                                      input={"measurement": {"experiment": {"simulationProgram": program}}})
                db = SimpleNamespace(get=AsyncMock(side_effect=lambda entity, _: SimpleNamespace(spec={"catalog_revision": "mixed-catalog"}) if entity is CaeBatch else None),
                                     add=Mock(), flush=AsyncMock(), scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: [])))
                attachments = [] if count == 2 else [SimpleNamespace(id="pressure", data=raw)]
                await stage_visualization(db, job, {"sequence": 1, "task": "solid", "visualizations": {"meanPressure": entry}}, attachments)
                staged = db.add.call_args.args[0]
                saved = json.loads(json.dumps(staged.payload))
                db.get.side_effect = None
                db.get.return_value = SimpleNamespace(experiment_id=7)
                db.scalars = AsyncMock(return_value=SimpleNamespace(all=lambda: [SimpleNamespace(task="solid", data=saved)]))
                with patch("service.measurement_service.require_experiment_read", AsyncMock()):
                    fetched = await get_visualizations(db, 5, user=None)
                result = fetched.visualizations["solid"]["meanPressure"]
                self.assertEqual(result["contract"], contract)
                self.assertEqual(result["schema"], schema)
                encoded = result["data"]["values"]["storage"]
                if count == 2:
                    self.assertEqual(encoded["value"], values)
                else:
                    self.assertEqual(base64.b64decode(encoded["data"]), raw)
