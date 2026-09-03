from __future__ import annotations

import asyncio
import inspect
import sys
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import configure_mappers


APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

import db  # noqa: E402
import gpstation.db  # noqa: E402, F401
import main  # noqa: E402
import models as api_models  # noqa: E402
import user_auth.db  # noqa: E402, F401
from ai.data_tools import VisibleDataError, VisibleDataReader  # noqa: E402
from model_validators import validate_calculation_data_selectors  # noqa: E402
from models import (  # noqa: E402
    CalculationDataListRequest,
    CalculationDataOutput,
    MeasurementBase,
    RoleEnum,
    UserData,
)
from pydantic import BaseModel, ValidationError  # noqa: E402
from service.calculation_data import (  # noqa: E402
    CALCULATION_DATA_CRUD_SPEC,
    list_calculation_data,
)


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
            {
                "id",
                "created_at",
                "updated_at",
                "experiment_id",
                "name",
                "description",
                "source_code",
                "source_hash",
                "output_layout",
                "preflight_measurement_id",
                "contract_status",
            },
            set(table.columns.keys()),
        )
        self.assertIn("experiment_records", db.Base.metadata.tables)
        self.assertIn("calculation_experiment_records", db.Base.metadata.tables)
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
        self.assertIn("/experiment_record/list", paths)
        self.assertNotIn("/designer_model/list", paths)
        self.assertNotIn("/predictor_model/list", paths)
        schemas = openapi["components"]["schemas"]
        self.assertNotIn("DesignerModelBase", schemas)
        self.assertNotIn("PredictorModelBase", schemas)
        self.assertIn("CalculationBase", schemas)
        self.assertIn("ExperimentRecordBase", schemas)
        self.assertIn("CalculationOutputLayout", schemas)

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
            "/calculation_data/list",
            "/calculation_data/analysis",
            "/calculation_data/analysis/status",
            "/calculation_data/missing",
            "/calculation_data/save",
            "/calculation_data/scalars",
        ):
            self.assertIn(path, openapi["paths"])
        self.assertIn("CalculationDataOutput", openapi["components"]["schemas"])
        self.assertIn("CalculationDataBase", openapi["components"]["schemas"])
        self.assertIn("CalculationDataListRequest", openapi["components"]["schemas"])
        self.assertIn("CalculationDataListResponse", openapi["components"]["schemas"])
        self.assertNotIn("CalculationDataAnalysisResponse", openapi["components"]["schemas"])
        self.assertNotIn("CalculationDataAnalysisStatusResponse", openapi["components"]["schemas"])

        def body_properties(path: str) -> set[str]:
            schema = openapi["paths"][path]["post"]["requestBody"]["content"]["application/json"]["schema"]
            component = schema["$ref"].rsplit("/", 1)[-1]
            return set(openapi["components"]["schemas"][component]["properties"])

        self.assertEqual({"experimentIds"}, body_properties("/experiment/usage"))
        self.assertTrue(
            {"experiment_id", "selected_ids", "search_text", "filter"}.issubset(
                body_properties("/calculation_data/list")
            )
        )
        list_schema = openapi["components"]["schemas"]["CalculationDataListRequest"]
        self.assertEqual(
            {"experiment_id", "selected_ids"},
            set(list_schema["required"]),
        )
        self.assertEqual(1, list_schema["properties"]["selected_ids"]["minItems"])
        self.assertEqual(50, list_schema["properties"]["selected_ids"]["maxItems"])
        self.assertEqual({"experiment_id"}, body_properties("/calculation_data/analysis"))
        self.assertEqual(
            {"experiment_id", "calculation_id", "measurement_id"},
            body_properties("/calculation_data/missing"),
        )
        self.assertEqual(
            {"calculation_id", "measurement_id", "source_hash", "data"},
            body_properties("/calculation_data/save"),
        )
        self.assertEqual(
            {"calculation_id", "exclude_measurement_id"},
            body_properties("/calculation_data/scalars"),
        )

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

    def test_calculation_data_list_requires_an_exact_positive_id_selection(self) -> None:
        request = CalculationDataListRequest(experiment_id=7, selected_ids=[3, 9])
        self.assertEqual(request.selected_ids, [3, 9])
        boundary = CalculationDataListRequest(experiment_id=7, selected_ids=list(range(1, 51)))
        self.assertEqual(len(boundary.selected_ids), 50)
        invalid_requests = (
            {"experiment_id": 0, "selected_ids": [1]},
            {"experiment_id": True, "selected_ids": [1]},
            {"experiment_id": "7", "selected_ids": [1]},
            {"experiment_id": 7.0, "selected_ids": [1]},
            {"experiment_id": 1, "selected_ids": []},
            {"experiment_id": 1, "selected_ids": [0]},
            {"experiment_id": 1, "selected_ids": [True]},
            {"experiment_id": 1, "selected_ids": ["2"]},
            {"experiment_id": 1, "selected_ids": [2.0]},
            {"experiment_id": 1, "selected_ids": [2, 2]},
            {"experiment_id": 1, "selected_ids": list(range(1, 52))},
        )
        for payload in invalid_requests:
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                CalculationDataListRequest.model_validate(payload)

    def test_calculation_data_list_base_clause_cannot_expand_selected_ids(self) -> None:
        request = CalculationDataListRequest(
            experiment_id=7,
            selected_ids=[3, 9],
            search_text="must-not-widen",
            filter={"calculation_id": [999, 999]},
        )
        user = UserData(
            id="00000000-0000-0000-0000-000000000123",
            roles=[RoleEnum.user],
        )
        get_list_response = AsyncMock(return_value={"total": 0, "items": []})

        async def run() -> str:
            with patch(
                "service.calculation_data.get_list_response",
                new=get_list_response,
            ):
                await list_calculation_data(object(), request, user=user)  # type: ignore[arg-type]
            call = get_list_response.await_args
            self.assertIs(call.args[1], request)
            self.assertIs(call.args[2], CALCULATION_DATA_CRUD_SPEC)
            self.assertEqual(CALCULATION_DATA_CRUD_SPEC.scope_path, ("measurement", "experiment"))
            statement = select(db.CalculationData.id).where(call.args[3])
            return str(
                statement.compile(
                    dialect=postgresql.dialect(),
                    compile_kwargs={"literal_binds": True},
                )
            )

        sql = asyncio.run(run())
        self.assertIn("calculation_data.id IN (3, 9)", sql)
        self.assertIn("calculations.experiment_id = 7", sql)
        self.assertIn("measurements.experiment_id = 7", sql)
        self.assertNotIn("999", sql)

    def test_measurement_contract_includes_calculation_data_count(self) -> None:
        measurement = MeasurementBase(
            user_id="00000000-0000-0000-0000-000000000001",
            experiment_id=1,
            vars={},
            material_parameters={},
        )
        self.assertEqual(measurement.calculation_data_count, 0)

    def test_models_module_keeps_only_required_pydantic_models(self) -> None:
        model_names = {
            name
            for name, value in vars(api_models).items()
            if inspect.isclass(value)
            and value.__module__ == "models"
            and issubclass(value, BaseModel)
        }
        self.assertGreaterEqual(len(model_names), 29)
        self.assertTrue(
            {
                "AuthenticatedUserData",
                "GetListResponseBase",
                "UpsertResponseBase",
                "ExperimentDerivedCounts",
                "MeasurementSaveResponse",
                "CalculationDataAnalysisResponse",
            }.isdisjoint(model_names)
        )

    def test_calculation_data_selector_validation_is_external(self) -> None:
        validate_calculation_data_selectors(1, None)
        with self.assertRaisesRegex(ValueError, "cannot be combined"):
            validate_calculation_data_selectors(1, 2)

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
