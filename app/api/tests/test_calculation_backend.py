from __future__ import annotations

import sys
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

from sqlalchemy.orm import configure_mappers


APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

import db  # noqa: E402
import gpstation.db  # noqa: E402, F401
import main  # noqa: E402
import user_auth.db  # noqa: E402, F401
from ai.data_tools import VisibleDataError, VisibleDataReader  # noqa: E402
from models import CalculationDataOutput, ExperimentDerivedCounts  # noqa: E402
from pydantic import ValidationError  # noqa: E402


class CalculationBackendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        configure_mappers()

    def test_calculation_metadata_replaces_legacy_model_tables(self) -> None:
        self.assertIn("calculations", db.Base.metadata.tables)
        self.assertNotIn("designer_models", db.Base.metadata.tables)
        self.assertNotIn("predictor_models", db.Base.metadata.tables)

        table = db.Base.metadata.tables["calculations"]
        self.assertEqual(
            {"id", "created_at", "updated_at", "experiment_id", "name", "description", "source_code"},
            set(table.columns.keys()),
        )
        self.assertFalse(table.c.experiment_id.nullable)
        foreign_key = next(iter(table.c.experiment_id.foreign_keys))
        self.assertEqual("experiments.id", foreign_key.target_fullname)
        self.assertEqual("CASCADE", foreign_key.ondelete)
        self.assertTrue(
            any(
                constraint.name == "uq_calculations_experiment_id_name"
                for constraint in table.constraints
            )
        )

    def test_openapi_only_exposes_calculation_crud(self) -> None:
        openapi = main.app.openapi()
        paths = openapi["paths"]
        self.assertIn("/calculation/list", paths)
        self.assertIn("/calculation/upsert", paths)
        self.assertIn("/calculation/", paths)
        self.assertNotIn("/designer_model/list", paths)
        self.assertNotIn("/predictor_model/list", paths)
        schemas = openapi["components"]["schemas"]
        self.assertNotIn("DesignerModelBase", schemas)
        self.assertNotIn("PredictorModelBase", schemas)
        self.assertIn("CalculationBase", schemas)

    def test_calculation_data_metadata_and_api_contract(self) -> None:
        self.assertIn("calculation_data", db.Base.metadata.tables)
        table = db.Base.metadata.tables["calculation_data"]
        self.assertEqual(
            {"id", "created_at", "updated_at", "calculation_id", "measurement_id", "data"},
            set(table.columns.keys()),
        )
        self.assertEqual(
            {"calculations.id", "measurements.id"},
            {foreign_key.target_fullname for column in table.columns for foreign_key in column.foreign_keys},
        )
        self.assertTrue(
            any(
                constraint.name == "uq_calculation_data_calculation_id_measurement_id"
                for constraint in table.constraints
            )
        )
        openapi = main.app.openapi()
        for path in (
            "/calculation_data/missing",
            "/calculation_data/save",
            "/calculation_data/scalars",
        ):
            self.assertIn(path, openapi["paths"])
        self.assertIn("CalculationDataOutput", openapi["components"]["schemas"])

    def test_calculation_data_output_validation(self) -> None:
        scalar = CalculationDataOutput.model_validate(
            {"dtype": "float64", "shape": [], "data": 2.5, "axes": []}
        )
        self.assertEqual(scalar.data, 2.5)
        line = CalculationDataOutput.model_validate(
            {
                "dtype": "int16",
                "shape": [2],
                "data": [1, 2],
                "axes": [{"name": "x", "ticks": [0, 1]}],
            }
        )
        self.assertEqual(line.shape, [2])
        invalid_outputs = (
            {"dtype": "float64", "shape": [2], "data": [1], "axes": [{"name": "x", "ticks": [0, 1]}]},
            {"dtype": "float64", "shape": [], "data": float("nan"), "axes": []},
            {"dtype": "uint8", "shape": [], "data": 256, "axes": []},
            {"dtype": "float64", "shape": [2], "data": [1, 2], "axes": []},
        )
        for payload in invalid_outputs:
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                CalculationDataOutput.model_validate(payload)

    def test_derived_counts_use_calculations(self) -> None:
        self.assertEqual(
            {"measurements", "recordedData", "calculations"},
            set(ExperimentDerivedCounts().model_dump()),
        )

    def test_legacy_models_are_not_ai_visible_resources(self) -> None:
        reader = VisibleDataReader(None, "user-id")  # type: ignore[arg-type]
        for resource in ("designer_model", "predictor_model"):
            with self.subTest(resource=resource), self.assertRaises(VisibleDataError):
                reader._simple_search_spec(resource)

    def test_calculation_migration_is_explicitly_irreversible(self) -> None:
        migration_path = (
            APP_DIR.parent
            / "alembic"
            / "versions"
            / "000000000002_calculations.py"
        )
        spec = spec_from_file_location("calculation_migration", migration_path)
        assert spec is not None and spec.loader is not None
        migration = module_from_spec(spec)
        spec.loader.exec_module(migration)
        with self.assertRaisesRegex(RuntimeError, "does not support downgrade"):
            migration.downgrade()


if __name__ == "__main__":
    unittest.main()
