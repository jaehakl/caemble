import unittest

from db import Experiment, GeometryPackage, GeometryRepository, GeometryVersion, Measurement
from models import ExperimentBase, GeometryModuleSnapshot, MeasurementBase
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
        self.assertEqual(value.source_bundle.formatVersion, 5)
        self.assertEqual(
            value.model_dump(mode="json")["source_bundle"],
            experiment_source_bundle(),
        )
        self.assertEqual(value.source_hash, "a" * 64)
        self.assertNotIn("code_embedding", value.model_dump())
        self.assertFalse(Experiment.__table__.columns.source_hash.nullable)

    def test_current_geometry_contract_uses_module_v4_and_cad_api_v7(self):
        value = GeometryModuleSnapshot(
            geometryVersionId=1,
            coordinate="caemble:geometry/owner/common/shape@1.0.0",
            moduleFormatVersion=4,
            cadApiVersion=7,
            description=None,
            source="export const Shape = () => <box />",
            sourceHash="a" * 64,
            moduleHash="b" * 64,
        )
        self.assertEqual(value.moduleFormatVersion, 4)
        self.assertEqual(value.cadApiVersion, 7)
        constraints = {str(item.sqltext) for item in GeometryVersion.__table__.constraints if hasattr(item, "sqltext")}
        self.assertIn("module_format_version = 4", constraints)
        self.assertIn("cad_api_version = 7", constraints)

    def test_removed_split_tables_are_not_mapped(self):
        table_names = set(Experiment.metadata.tables)
        self.assertNotIn("structures", table_names)
        self.assertNotIn("samples", table_names)
        self.assertNotIn("setups", table_names)
        self.assertIn("experiments", table_names)
        self.assertIn("measurements", table_names)

    def test_geometry_contract_is_immutable_repository_package_version(self):
        table_names = set(Experiment.metadata.tables)
        self.assertNotIn("geometries", table_names)
        self.assertIn(GeometryRepository.__tablename__, table_names)
        self.assertIn(GeometryPackage.__tablename__, table_names)
        self.assertIn(GeometryVersion.__tablename__, table_names)
        self.assertNotIn("parent_id", GeometryVersion.__table__.columns)

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
