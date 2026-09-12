from __future__ import annotations

import asyncio
import os
import sys
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from box_grid_fixtures import box_schema, box_tensor
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from db import Calculation, CalculationData, CalculationExperimentRecord, Experiment, ExperimentDemo, ExperimentRecord, Measurement, RecordedData, make_async_db_url
from models import CalculationBase, CalculationDataOutput, RoleEnum, SaveExperimentRequest, UserData
from service.calculation import upsert_calculations
from service.calculation_data import save_calculation_data
from service.experiment import _source_locked, save_experiment
from service.measurement_service import get_recorded_data
from test_calculation_database import _create_database, _database_url, _drop_database, _seed_owners, _upgrade


DEFINITIONS = [
    {"name": "평균", "description": "예제", "source_code": "export default record => record.signal"},
    {"name": "Second", "source_code": "export default record => record.signal"},
]
RECORD = {"name": "signal", "quantity_kind": "Dimensionless", "tensor_order": 0, "dtype": "float64", "data_schema": box_schema()}
CREATE = dict(mode="create", namespace="calc-owner", repository="copies", key="original", name="Original",
              sourceBundle={"files": {"experiment.tsx": "export default null"}}, bundleHash="server-computes-hash", records=[RECORD], result_contracts={"signal": {"task": "fixture", "output": "signal", "solver": {"name": "fixture", "version": "1.0.0"}, "artifactType": "fixture@1", "catalogRevision": "fixture", "visualization": {"kind": "tensor"}, "schema": box_schema()}})


class ExperimentCalculationRequestTests(unittest.TestCase):
    def test_copy_inputs_are_create_only_exclusive_and_validated(self):
        for fields in (
            {"calculations": DEFINITIONS, "copyCalculationsFromExperimentId": 1},
            {"mode": "new_version", "calculations": []},
            {"mode": "overwrite", "copyCalculationsFromExperimentId": 1},
            {"copyCalculationsFromExperimentId": 0},
            {"calculations": [DEFINITIONS[0], {**DEFINITIONS[0], "name": " 평균 "}]},
            {"calculations": [{"name": " ", "source_code": "code"}]},
            {"calculations": [{"name": "A", "source_code": "\n"}]},
        ):
            with self.subTest(fields=fields), self.assertRaises(ValidationError):
                SaveExperimentRequest(**{**CREATE, **fields})
        self.assertEqual(SaveExperimentRequest(**CREATE, calculations=[]).calculations, [])

    def test_only_measurements_lock_source(self):
        self.assertFalse(_source_locked({"measurements": 0, "recordedData": 10, "calculations": 4}))
        self.assertTrue(_source_locked({"measurements": 1, "recordedData": 0, "calculations": 0}))


@unittest.skipUnless(os.getenv("RUN_CALCULATION_DB_TESTS") == "1", "Requires disposable PostgreSQL databases")
class ExperimentCalculationCopyDatabaseTests(unittest.TestCase):
    def test_copy_preflight_overwrite_permissions_and_atomicity(self):
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"

        async def verify():
            owner_id, other_id, _, private_id = await _seed_owners(database)
            owner = UserData(id=owner_id, roles=[RoleEnum.user])
            engine = create_async_engine(make_async_db_url(_database_url(database)))
            sessions = async_sessionmaker(engine, expire_on_commit=False)
            try:
                async with sessions() as db:
                    original = await save_experiment(db, SaveExperimentRequest(**CREATE, calculations=DEFINITIONS), user=owner)
                    self.assertEqual(original["result_contracts"], CREATE["result_contracts"])
                    self.assertEqual(original["derivedCounts"], {"measurements": 0, "recordedData": 0, "calculations": 2})
                    self.assertFalse(original["sourceLocked"])
                    rows = list((await db.scalars(select(Calculation).where(Calculation.experiment_id == original["id"]).order_by(Calculation.id))).all())
                    original_ids = [row.id for row in rows]
                    for row in rows:
                        self.assertEqual(row.contract_status, "needs_preflight")
                        self.assertEqual(row.revision, 1)
                        self.assertIsNone(row.output_layout)
                        self.assertIsNone(row.preflight_measurement_id)

                    # A real target preflight promotes the imported definition and supports result persistence.
                    measurement = Measurement(user_id=owner_id, experiment_id=original["id"], vars={}, material_snapshot={}, recorded_at=datetime.now(timezone.utc))
                    db.add(measurement)
                    await db.flush()
                    record = await db.scalar(select(ExperimentRecord).where(ExperimentRecord.experiment_id == original["id"]))
                    db.add(RecordedData(user_id=owner_id, measurement_id=measurement.id, experiment_record_id=record.id, data=box_tensor()))
                    await db.commit()
                    layout = {"dtype": "float64", "shape": [], "axes": []}
                    await upsert_calculations(db, [CalculationBase(
                        id=rows[0].id, experiment_id=original["id"], base_revision=1,
                        **DEFINITIONS[0], source_hash=rows[0].source_hash,
                        output_layout=layout, preflight_measurement_id=measurement.id,
                        contract_status="ready", experiment_record_ids=[record.id],
                    )], user=owner)
                    await save_calculation_data(db, rows[0].id, measurement.id, rows[0].source_hash,
                                               CalculationDataOutput(**layout, data=3), user=owner)

                    copied = await save_experiment(db, SaveExperimentRequest(**{**CREATE, "key": "save-as"}, copyCalculationsFromExperimentId=original["id"]), user=owner)
                    copy_rows = list((await db.scalars(select(Calculation).where(Calculation.experiment_id == copied["id"]).order_by(Calculation.id))).all())
                    self.assertEqual([row.name for row in copy_rows], [row.name for row in rows])
                    self.assertTrue(set(original_ids).isdisjoint(row.id for row in copy_rows))
                    for row in copy_rows:
                        self.assertEqual((row.revision, row.contract_status, row.output_layout, row.preflight_measurement_id), (1, "needs_preflight", None, None))
                    self.assertEqual(copied["derivedCounts"], {"measurements": 0, "recordedData": 0, "calculations": 2})
                    self.assertEqual(await db.scalar(select(func.count()).select_from(CalculationExperimentRecord).where(CalculationExperimentRecord.calculation_id.in_([row.id for row in copy_rows]))), 0)

                    # New versions copy the selected version, even when a newer version has different definitions.
                    version_request = {**CREATE, "mode": "new_version", "experimentId": original["id"], "baseBundleHash": original["bundleHash"], "bump": "patch"}
                    version = await save_experiment(db, SaveExperimentRequest(**version_request), user=owner)
                    await db.execute(delete(Calculation).where(Calculation.experiment_id == version["id"]))
                    await db.commit()
                    next_version = await save_experiment(db, SaveExperimentRequest(**version_request), user=owner)
                    self.assertEqual(next_version["version"], "0.1.2")
                    self.assertEqual(next_version["derivedCounts"]["calculations"], 2)

                    # Metadata-only save keeps the ready contract and never duplicates definitions.
                    overwrite = {**CREATE, "mode": "overwrite", "experimentId": original["id"], "baseBundleHash": original["bundleHash"]}
                    await save_experiment(db, SaveExperimentRequest(**{**overwrite, "name": "Renamed"}), user=owner)
                    await db.refresh(rows[0])
                    self.assertEqual((rows[0].contract_status, rows[0].revision), ("ready", 2))
                    changed_source = {"files": {"experiment.tsx": "export default 1"}}
                    with self.assertRaises(HTTPException) as failure:
                        await save_experiment(db, SaveExperimentRequest(**{**overwrite, "sourceBundle": changed_source}), user=owner)
                    self.assertEqual(failure.exception.detail["code"], "experiment_source_locked")

                    # After Measurement removal, source and Record changes invalidate existing contracts.
                    await db.execute(delete(Measurement).where(Measurement.experiment_id == original["id"]))
                    await db.commit()
                    changed = await save_experiment(db, SaveExperimentRequest(**{**overwrite, "sourceBundle": changed_source, "records": [{**RECORD, "name": "renamed"}], "result_contracts": {"renamed": CREATE["result_contracts"]["signal"]}}), user=owner)
                    await db.refresh(rows[0])
                    self.assertFalse(changed["sourceLocked"])
                    self.assertEqual((rows[0].contract_status, rows[0].revision, rows[0].output_layout, rows[0].preflight_measurement_id), ("needs_preflight", 3, None, None))
                    self.assertEqual(await db.scalar(select(func.count()).select_from(CalculationExperimentRecord).where(CalculationExperimentRecord.calculation_id.in_(original_ids))), 0)
                    self.assertEqual(await db.scalar(select(func.count()).select_from(CalculationData)), 0)
                    for row in copy_rows:
                        await db.refresh(row)
                        self.assertEqual(row.revision, 1)

                    # Unrecorded Measurements also lock; no Calculation or RecordedData is required.
                    empty = await save_experiment(db, SaveExperimentRequest(**{**CREATE, "key": "empty"}), user=owner)
                    stored_measurement = Measurement(user_id=owner_id, experiment_id=empty["id"], vars={}, material_snapshot={})
                    db.add(stored_measurement)
                    await db.commit()
                    reopened = await get_recorded_data(db, stored_measurement.id, user=owner)
                    self.assertEqual(reopened.result_contracts, CREATE["result_contracts"])
                    self.assertEqual(reopened.recorded_data, {})
                    with self.assertRaises(HTTPException) as failure:
                        await save_experiment(db, SaveExperimentRequest(**{**overwrite, "key": "empty", "experimentId": empty["id"], "baseBundleHash": empty["bundleHash"], "records": [], "result_contracts": {}}), user=owner)
                    self.assertEqual(failure.exception.detail["code"], "experiment_record_contract_locked")

                    with self.assertRaises(HTTPException) as failure:
                        await save_experiment(db, SaveExperimentRequest(**{**CREATE, "key": "private-copy"}, copyCalculationsFromExperimentId=private_id), user=owner)
                    self.assertEqual(failure.exception.status_code, 404)
                    db.add(Calculation(experiment_id=private_id, name="Public calculation", source_code="export default () => 1", contract_status="needs_preflight"))
                    db.add(ExperimentDemo(experiment_id=private_id, display_order=0))
                    await db.commit()
                    public_copy = await save_experiment(db, SaveExperimentRequest(**{**CREATE, "key": "demo-copy"}, copyCalculationsFromExperimentId=private_id), user=owner)
                    self.assertEqual(public_copy["derivedCounts"]["calculations"], 1)
                    self.assertEqual((await db.get(Experiment, public_copy["id"])).user_id, owner_id)

                    # Any failure after inserts rolls back the Experiment, its Records, and Calculations.
                    count_before = await db.scalar(select(func.count()).select_from(Calculation))
                    with patch.object(db, "commit", AsyncMock(side_effect=RuntimeError("injected failure"))), self.assertRaisesRegex(RuntimeError, "injected"):
                        await save_experiment(db, SaveExperimentRequest(**{**CREATE, "key": "rollback"}, calculations=DEFINITIONS), user=owner)
                    self.assertIsNone(await db.scalar(select(Experiment.id).where(Experiment.experiment_key == "rollback")))
                    self.assertEqual(await db.scalar(select(func.count()).select_from(Calculation)), count_before)
            finally:
                await engine.dispose()

        asyncio.run(_create_database(database))
        try:
            _upgrade(database, "head")
            asyncio.run(verify())
        finally:
            asyncio.run(_drop_database(database))
