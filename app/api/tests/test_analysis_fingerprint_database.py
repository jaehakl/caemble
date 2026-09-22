from __future__ import annotations

import asyncio
import hashlib
import os
import sys
import unittest
import uuid
from datetime import timedelta
from pathlib import Path

from sqlalchemy import delete, event, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from db import CalculationData, Measurement, make_async_db_url
from models import CalculationDataOutput, RoleEnum, UserData
from service.calculation import upsert_calculations
from service.calculation_data import analyze_calculation_data, calculation_data_analysis_status, save_calculation_data
from test_calculation_database import (
    _create_database,
    _database_url,
    _drop_database,
    _ready_calculation,
    _seed_calculation_data,
    _upgrade,
)


@unittest.skipUnless(
    os.getenv("RUN_CALCULATION_DB_TESTS") == "1",
    "Set RUN_CALCULATION_DB_TESTS=1 to use disposable PostgreSQL databases.",
)
class AnalysisFingerprintDatabaseTests(unittest.TestCase):
    def test_status_tracks_analysis_input_and_result_changes_without_loading_tensors(self):
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"

        async def verify():
            owner_id, _, experiment_id, _, first_id, second_id, _, _ = await _seed_calculation_data(database)
            engine = create_async_engine(make_async_db_url(_database_url(database)))
            sessions = async_sessionmaker(engine, expire_on_commit=False)
            owner = UserData(id=owner_id, roles=[RoleEnum.user])
            source = "export default () => ({ dtype: 'float64', data: 1 })"
            source_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()
            output = CalculationDataOutput.model_validate({"dtype": "float64", "shape": [], "axes": [], "data": 1})
            statements = []

            def record_statement(connection, cursor, statement, parameters, context, executemany):
                statements.append(statement)

            async def read_status():
                statements.clear()
                async with sessions() as session:
                    status = await calculation_data_analysis_status(session, experiment_id, user=owner)
                self.assertTrue(statements)
                self.assertFalse(any("calculation_data.data" in statement for statement in statements))
                async with sessions() as session:
                    analysis = await analyze_calculation_data(session, experiment_id, user=owner)
                self.assertEqual(status["fingerprint"], analysis["fingerprint"])
                self.assertEqual(status["total"], analysis["total"])
                return status

            event.listen(engine.sync_engine, "before_cursor_execute", record_statement)
            try:
                async with sessions() as session:
                    created = await upsert_calculations(session, [
                        _ready_calculation(experiment_id, "Stress", source, first_id)
                    ], user=owner)
                    calculation_id = created[0]["id"]
                    await save_calculation_data(session, calculation_id, first_id, source_hash, output, user=owner)
                original = await read_status()
                self.assertEqual(original["measurement_count"], 1)

                async with sessions() as session:
                    await session.execute(update(Measurement).where(Measurement.id == first_id).values(
                        vars={"x": 2}, updated_at=Measurement.updated_at + timedelta(seconds=1),
                    ))
                    await session.commit()
                changed_input = await read_status()
                self.assertNotEqual(changed_input["fingerprint"], original["fingerprint"])

                async with sessions() as session:
                    await session.execute(update(CalculationData).where(
                        CalculationData.calculation_id == calculation_id,
                        CalculationData.measurement_id == first_id,
                    ).values(
                        data={"dtype": "float64", "shape": [], "axes": [], "data": 2},
                        updated_at=CalculationData.updated_at + timedelta(seconds=1),
                    ))
                    await session.commit()
                changed_result = await read_status()
                self.assertNotEqual(changed_result["fingerprint"], changed_input["fingerprint"])

                async with sessions() as session:
                    await save_calculation_data(session, calculation_id, second_id, source_hash, output, user=owner)
                added = await read_status()
                self.assertNotEqual(added["fingerprint"], changed_result["fingerprint"])
                self.assertEqual(added["measurement_count"], 2)

                async with sessions() as session:
                    await session.execute(delete(Measurement).where(Measurement.id == first_id))
                    await session.commit()
                deleted = await read_status()
                self.assertNotEqual(deleted["fingerprint"], added["fingerprint"])
                self.assertEqual(deleted["measurement_count"], 1)

                async with sessions() as session:
                    await session.execute(delete(CalculationData).where(CalculationData.calculation_id == calculation_id))
                    await session.commit()
                empty = await read_status()
                self.assertNotEqual(empty["fingerprint"], deleted["fingerprint"])
                self.assertEqual(empty["total"], 0)
                self.assertEqual(empty["measurement_count"], 0)
            finally:
                await engine.dispose()

        try:
            asyncio.run(_create_database(database))
            _upgrade(database, "head")
            asyncio.run(verify())
        finally:
            asyncio.run(_drop_database(database))
