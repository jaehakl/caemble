import unittest

from db import Experiment, Measurement
from models import ExperimentBase, MeasurementBase
from tests.helpers import experiment_source_bundle


class TestCodeEntityContract(unittest.TestCase):
    def test_experiment_contract_owns_repository_semver_and_bundle_v6(self):
        value = ExperimentBase.model_validate(
            {
                "user_id": "00000000-0000-0000-0000-000000000001",
                "namespace": "owner-name",
                "repository_slug": "examples",
                "experiment_key": "beam",
                "version_major": 1,
                "version_minor": 2,
                "version_patch": 3,
                "name": "Experiment",
                "source_bundle": experiment_source_bundle(),
                "source_hash": "a" * 64,
            }
        )
        self.assertEqual(value.source_bundle.formatVersion, 6)
        self.assertEqual(value.version_major, 1)
        self.assertNotIn("code_embedding", value.model_dump())
        self.assertFalse(Experiment.__table__.columns.user_id.nullable)
        self.assertNotIn("parent_id", Experiment.__table__.columns)

    def test_geometry_and_projection_tables_are_not_mapped(self):
        table_names = set(Experiment.metadata.tables)
        self.assertFalse(
            {
                "geometries",
                "geometry_repositories",
                "geometry_packages",
                "geometry_versions",
                "geometry_imports",
                "experiment_geometry_imports",
                "experiment_geometry_modules",
            }
            & table_names
        )

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
