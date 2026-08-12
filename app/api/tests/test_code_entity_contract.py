import unittest

from db import Experiment, Geometry, Measurement
from models import ExperimentBase, GeometryBase, MeasurementBase
from tests.helpers import experiment_source_bundle


class TestCodeEntityContract(unittest.TestCase):
    def test_experiment_contract_exposes_server_source_hash(self):
        value = ExperimentBase.model_validate(
            {
                "name": "Experiment",
                "source_bundle": experiment_source_bundle(),
                "source_hash": "a" * 64,
            }
        )
        self.assertEqual(value.source_bundle.formatVersion, 2)
        self.assertEqual(value.source_hash, "a" * 64)
        self.assertNotIn("code_embedding", value.model_dump())
        self.assertFalse(Experiment.__table__.columns.source_hash.nullable)

    def test_removed_split_tables_are_not_mapped(self):
        table_names = set(Experiment.metadata.tables)
        self.assertNotIn("structures", table_names)
        self.assertNotIn("samples", table_names)
        self.assertNotIn("setups", table_names)
        self.assertIn("experiments", table_names)
        self.assertIn("measurements", table_names)

    def test_geometry_contract_is_unchanged(self):
        geometry = GeometryBase(name="Geometry", code="source")
        self.assertEqual(geometry.code, "source")
        self.assertIn("code", Geometry.__table__.columns)

    def test_measurement_contract_contains_complete_input_snapshot(self):
        value = MeasurementBase(
            user_id="00000000-0000-0000-0000-000000000001",
            experiment_id=1,
            vars={"width": 1},
            material_parameters={
                "schemaVersion": 2,
                "experiment": {"schemaVersion": 1, "materials": {}},
                "tasks": {"main": {"schemaVersion": 1, "materials": {}}},
            },
        )
        self.assertIsNone(value.recorded_at)
        self.assertIn("recorded_at", Measurement.__table__.columns)


if __name__ == "__main__":
    unittest.main()
