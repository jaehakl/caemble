from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import configure_mappers


APP_DIR = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP_DIR))

import db  # noqa: E402
import gpstation.db  # noqa: E402, F401
import main  # noqa: E402
import user_auth.db  # noqa: E402, F401
from models import DemoExperimentUpdateRequest, GetListRequestBase  # noqa: E402
from service.calculation import CALCULATION_CRUD_SPEC  # noqa: E402
from service.calculation_data import CALCULATION_DATA_CRUD_SPEC  # noqa: E402
from service.experiment import EXPERIMENT_CRUD_SPEC, EXPERIMENT_RECORD_CRUD_SPEC  # noqa: E402
from service.measurement_service import MEASUREMENT_CRUD_SPEC  # noqa: E402
from service.recorded_data import RECORDED_DATA_CRUD_SPEC  # noqa: E402
from service.experiment_access import require_experiment_read, require_experiment_write  # noqa: E402
from service.demo_experiment import replace_demo_experiments  # noqa: E402
from utils.crud.common import build_scope_clause  # noqa: E402


class DemoExperimentContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        configure_mappers()

    def test_demo_table_has_exact_version_order_default_and_cascade_contract(self) -> None:
        table = db.Base.metadata.tables["experiment_demos"]
        self.assertEqual(
            {"experiment_id", "display_order", "is_default", "created_at", "updated_at"},
            set(table.columns.keys()),
        )
        foreign_key = next(iter(table.c.experiment_id.foreign_keys))
        self.assertEqual("experiments.id", foreign_key.target_fullname)
        self.assertEqual("CASCADE", foreign_key.ondelete)
        self.assertTrue(any(item.name == "uq_experiment_demos_display_order" for item in table.constraints))
        self.assertIn("uq_experiment_demos_single_default", {item.name for item in table.indexes})

    def test_demo_update_requires_unique_ordered_ids_and_one_valid_default(self) -> None:
        request = DemoExperimentUpdateRequest(experiment_ids=[9, 3], default_experiment_id=3)
        self.assertEqual([9, 3], request.experiment_ids)
        DemoExperimentUpdateRequest(experiment_ids=[], default_experiment_id=None)
        for payload in (
            {"experiment_ids": [1, 1], "default_experiment_id": 1},
            {"experiment_ids": [1], "default_experiment_id": 2},
            {"experiment_ids": [0], "default_experiment_id": 0},
            {"experiment_ids": [], "default_experiment_id": 1},
            {"experiment_ids": [1], "default_experiment_id": None},
        ):
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                DemoExperimentUpdateRequest.model_validate(payload)

    def test_scope_is_explicit_and_demo_access_reaches_experiment_for_every_read_model(self) -> None:
        self.assertEqual(GetListRequestBase(scope="public").scope, "public")
        with self.assertRaises(ValidationError):
            GetListRequestBase(scope="everything")

        specs = (
            EXPERIMENT_CRUD_SPEC,
            EXPERIMENT_RECORD_CRUD_SPEC,
            MEASUREMENT_CRUD_SPEC,
            RECORDED_DATA_CRUD_SPEC,
            CALCULATION_CRUD_SPEC,
            CALCULATION_DATA_CRUD_SPEC,
        )
        for spec in specs:
            with self.subTest(model=spec.model.__name__):
                clause = build_scope_clause(spec, None, write=False, read_scope="visible")
                sql = str(
                    select(spec.model.id)
                    .where(clause)
                    .compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
                )
                self.assertIn("experiment_demos", sql)
                self.assertIn("experiments", sql)

    def test_public_and_admin_routes_expose_only_expected_methods(self) -> None:
        paths = main.app.openapi()["paths"]
        self.assertIn("get", paths["/experiment/available"])
        self.assertIn("put", paths["/admin/demo-experiments"])
        self.assertIn("get", paths["/admin/demo-experiments/candidates"])
        self.assertEqual({"delete"}, set(paths["/user_admin/{id}"]))

    def test_demo_read_is_revoked_immediately_and_write_never_uses_demo_visibility(self) -> None:
        async def run() -> None:
            experiment = SimpleNamespace(id=7, user_id="admin-owner")
            database = SimpleNamespace(
                get=AsyncMock(return_value=experiment),
                scalar=AsyncMock(side_effect=[7, None]),
            )
            self.assertIs(await require_experiment_read(database, 7, None), experiment)
            with self.assertRaises(HTTPException) as revoked:
                await require_experiment_read(database, 7, None)
            self.assertEqual(404, revoked.exception.status_code)

            with self.assertRaises(HTTPException) as anonymous_write:
                await require_experiment_write(database, 7, None)
            self.assertEqual(404, anonymous_write.exception.status_code)
            with self.assertRaises(HTTPException) as other_user_write:
                await require_experiment_write(database, 7, SimpleNamespace(id="other", roles=[]))
            self.assertEqual(404, other_user_write.exception.status_code)
            self.assertIs(
                await require_experiment_write(database, 7, SimpleNamespace(id="admin-owner", roles=[])),
                experiment,
            )

        import asyncio

        asyncio.run(run())

    def test_curation_rejects_owner_and_readiness_then_preserves_requested_order(self) -> None:
        class Result:
            def __init__(self, values):
                self.values = values

            def all(self):
                return self.values

        async def run() -> None:
            experiments = [SimpleNamespace(id=1, user_id="admin"), SimpleNamespace(id=2, user_id="admin")]
            database = SimpleNamespace(
                scalars=AsyncMock(side_effect=[Result(experiments), Result(["admin"])]),
                execute=AsyncMock(),
                flush=AsyncMock(),
                commit=AsyncMock(),
                add_all=Mock(),
            )
            request = DemoExperimentUpdateRequest(experiment_ids=[2, 1], default_experiment_id=1)
            with (
                patch(
                    "service.demo_experiment._prediction_counts",
                    new=AsyncMock(
                        return_value={
                            1: {"recordedMeasurements": 1, "readyCalculations": 1, "calculationData": 1},
                            2: {"recordedMeasurements": 2, "readyCalculations": 1, "calculationData": 2},
                        }
                    ),
                ),
                patch(
                    "service.demo_experiment.available_experiments",
                    new=AsyncMock(return_value={"mine": [], "demos": []}),
                ),
            ):
                await replace_demo_experiments(
                    database,
                    request,
                    user=SimpleNamespace(id="admin", roles=["admin"]),
                )
            added = database.add_all.call_args.args[0]
            self.assertEqual([2, 1], [item.experiment_id for item in added])
            self.assertEqual([0, 1], [item.display_order for item in added])
            self.assertEqual([False, True], [item.is_default for item in added])
            database.flush.assert_awaited_once()
            database.commit.assert_awaited_once()

            invalid_owner_database = SimpleNamespace(
                scalars=AsyncMock(side_effect=[Result([SimpleNamespace(id=1, user_id="user")]), Result([])])
            )
            with self.assertRaises(HTTPException) as invalid_owner:
                await replace_demo_experiments(
                    invalid_owner_database,
                    DemoExperimentUpdateRequest(experiment_ids=[1], default_experiment_id=1),
                    user=SimpleNamespace(id="admin", roles=["admin"]),
                )
            self.assertEqual(422, invalid_owner.exception.status_code)

            not_ready_database = SimpleNamespace(
                scalars=AsyncMock(
                    side_effect=[Result([SimpleNamespace(id=1, user_id="admin")]), Result(["admin"])]
                )
            )
            with (
                patch(
                    "service.demo_experiment._prediction_counts",
                    new=AsyncMock(
                        return_value={
                            1: {"recordedMeasurements": 1, "readyCalculations": 1, "calculationData": 0}
                        }
                    ),
                ),
                self.assertRaises(HTTPException) as not_ready,
            ):
                await replace_demo_experiments(
                    not_ready_database,
                    DemoExperimentUpdateRequest(experiment_ids=[1], default_experiment_id=1),
                    user=SimpleNamespace(id="admin", roles=["admin"]),
                )
            self.assertEqual(422, not_ready.exception.status_code)

        import asyncio

        asyncio.run(run())

    def test_migration_declares_partial_single_default_index(self) -> None:
        migration = (APP_DIR.parent / "alembic" / "versions" / "000000000005_experiment_demos.py").read_text(
            encoding="utf-8"
        )
        self.assertIn('revision = "000000000005"', migration)
        self.assertIn('down_revision = "000000000004"', migration)
        self.assertIn('postgresql_where=sa.text("is_default")', migration)
        self.assertIn('ondelete="CASCADE"', migration)


if __name__ == "__main__":
    unittest.main()
