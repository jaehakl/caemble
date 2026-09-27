"""Real PostgreSQL migration and shared-source lifecycle checks; no Solver calls."""
import asyncio
import hashlib
import os
import unittest
import uuid

import asyncpg
from alembic import command
from alembic.config import Config
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from test_calculation_database import (
    API_DIR, ORIGINAL_DB_URL, _connect_arguments, _create_database, _database_url,
    _drop_database, _ready_calculation, _seed_calculation_data, _upgrade, _check,
)
from db import Calculation, CalculationData, CalculationSource, make_async_db_url
from models import CalculationDataOutput, CalculationListRequest, RoleEnum, UserData
from service.calculation import delete_calculations, list_calculations, upsert_calculations
from service.calculation_data import save_calculation_data
from service.calculation_library import library_detail
from service.data_tools import VisibleDataError, VisibleDataReader
from calculation_library_models import LibraryReference
from caemble_catalog import Catalog
from settings import settings


def downgrade(database):
    settings.db_url = _database_url(database)
    try:
        command.downgrade(Config(str(API_DIR / "alembic.ini")), "000000000015")
    finally:
        settings.db_url = ORIGINAL_DB_URL


@unittest.skipUnless(os.getenv("RUN_CALCULATION_DB_TESTS") == "1", "Requires disposable PostgreSQL databases")
class CalculationSourcesDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        asyncio.run(_create_database(self.database))
        self.addCleanup(lambda: asyncio.run(_drop_database(self.database)))
        _upgrade(self.database, "head")

    def test_migration_preserves_bindings_contracts_results_and_object_references(self):
        downgrade(self.database)
        owner, _, experiment, other_experiment, measurement, _, _, other_measurement = asyncio.run(_seed_calculation_data(self.database))
        code = "// 한글\r\nexport default () => 1\r\n"
        digest = hashlib.sha256(code.encode("utf-8")).hexdigest()
        object_id = str(uuid.uuid4())

        async def seed():
            connection = await asyncpg.connect(**_connect_arguments(self.database))
            try:
                ids = []
                for target, preflight, name in [(experiment, measurement, "원본"), (other_experiment, other_measurement, "승계")]:
                    ids.append(await connection.fetchval("""
                        INSERT INTO calculations (experiment_id, name, description, source_code, source_hash,
                            contract_status, output_layout, preflight_measurement_id, revision)
                        VALUES ($1, $2, '설명', $3, $4, 'ready', '{"dtype":"float64","shape":[],"axes":[]}', $5, 7)
                        RETURNING id
                    """, target, name, code, digest, preflight))
                data_id = await connection.fetchval("""
                    INSERT INTO calculation_data (calculation_id, measurement_id, data)
                    VALUES ($1, $2, '{"dtype":"float64","shape":[],"axes":[],"data":1}') RETURNING id
                """, ids[0], measurement)
                record_id = await connection.fetchval("""
                    INSERT INTO experiment_records (experiment_id, name, tensor_order, dtype, contract_hash)
                    VALUES ($1, 'input', 0, 'float64', 'record-contract') RETURNING id
                """, experiment)
                await connection.execute("INSERT INTO calculation_experiment_records VALUES ($1, $2)", ids[0], record_id)
                await connection.execute("""
                    INSERT INTO storage_objects (id, user_id, experiment_id, measurement_id, calculation_id,
                        calculation_data_id, purpose, manifest, ready, bound, deleting)
                    VALUES ($1, $2, $3, $4, $5, $6, 'calculation', '{}', true, true, false)
                """, object_id, owner, experiment, measurement, ids[0], data_id)
                before = [dict(row) for row in await connection.fetch("SELECT * FROM calculations ORDER BY id")]
                return ids, data_id, record_id, before
            finally:
                await connection.close()

        ids, data_id, record_id, before = asyncio.run(seed())
        _upgrade(self.database, "head")
        _check(self.database)

        async def inspect():
            connection = await asyncpg.connect(**_connect_arguments(self.database))
            try:
                self.assertEqual(await connection.fetchval("SELECT count(*) FROM calculation_sources"), 1)
                rows = await connection.fetch("SELECT c.*, s.source_code, s.source_hash FROM calculations c JOIN calculation_sources s ON s.id = c.source_id ORDER BY c.id")
                self.assertEqual(rows[0]["source_id"], rows[1]["source_id"])
                for old, row in zip(before, rows):
                    self.assertEqual(old, {key: row[key] for key in old})
                self.assertEqual(await connection.fetchval("SELECT calculation_id FROM calculation_data WHERE id = $1", data_id), ids[0])
                self.assertEqual(await connection.fetchval("SELECT experiment_record_id FROM calculation_experiment_records WHERE calculation_id = $1", ids[0]), record_id)
                reference = await connection.fetchrow("SELECT calculation_id, calculation_data_id, bound, deleting FROM storage_objects WHERE id = $1", object_id)
                self.assertEqual(tuple(reference), (ids[0], data_id, True, False))
                with self.assertRaises(asyncpg.RaiseError):
                    await connection.execute("UPDATE calculation_sources SET source_code = 'changed'")
            finally:
                await connection.close()
        asyncio.run(inspect())
        downgrade(self.database)

        async def verify_downgrade():
            connection = await asyncpg.connect(**_connect_arguments(self.database))
            try:
                self.assertEqual(before, [dict(row) for row in await connection.fetch("SELECT * FROM calculations ORDER BY id")])
            finally:
                await connection.close()
        asyncio.run(verify_downgrade())

    def test_invalid_ready_hash_aborts_transaction(self):
        downgrade(self.database)
        _, _, experiment, _, measurement, *_ = asyncio.run(_seed_calculation_data(self.database))

        async def corrupt():
            connection = await asyncpg.connect(**_connect_arguments(self.database))
            try:
                return await connection.fetchval("""
                    INSERT INTO calculations (experiment_id, name, source_code, source_hash, contract_status, preflight_measurement_id)
                    VALUES ($1, 'invalid', 'code', 'wrong', 'ready', $2) RETURNING id
                """, experiment, measurement)
            finally:
                await connection.close()
        identifier = asyncio.run(corrupt())
        with self.assertRaisesRegex(RuntimeError, f"Calculation {identifier} is ready"):
            _upgrade(self.database, "head")

        async def verify():
            connection = await asyncpg.connect(**_connect_arguments(self.database))
            try:
                self.assertEqual(await connection.fetchval("SELECT version_num FROM alembic_version"), "000000000015")
                self.assertIsNone(await connection.fetchval("SELECT to_regclass('calculation_sources')"))
                self.assertEqual(await connection.fetchval("SELECT source_hash FROM calculations WHERE id = $1", identifier), "wrong")
            finally:
                await connection.close()
        asyncio.run(verify())

    def test_concurrent_reuse_copy_on_write_permissions_and_local_deletion(self):
        async def verify():
            owner_id, other_id, experiment, other_experiment, measurement, _, _, other_measurement = await _seed_calculation_data(self.database)
            owner = UserData(id=owner_id, roles=[RoleEnum.user])
            other = UserData(id=other_id, roles=[RoleEnum.user])
            engine = create_async_engine(make_async_db_url(_database_url(self.database)))
            sessions = async_sessionmaker(engine, expire_on_commit=False)
            code = "// shared 한국어\nexport default () => 1"

            async def save(target, preflight, user, name):
                async with sessions() as db:
                    return (await upsert_calculations(db, [_ready_calculation(target, name, code, preflight)], user=user))[0]["id"]
            try:
                left, right = await asyncio.gather(save(experiment, measurement, owner, "Left"), save(other_experiment, other_measurement, other, "Right"))
                async with sessions() as db:
                    a, b = await db.get(Calculation, left), await db.get(Calculation, right)
                    original_source = a.source_id
                    self.assertEqual(original_source, b.source_id)
                    self.assertEqual(await db.scalar(select(func.count()).select_from(CalculationSource)), 1)
                    reader = VisibleDataReader(db, owner_id)
                    self.assertEqual((await reader.detail("calculation", left))["sourceSha256"], a.source_hash)
                    await reader.read_source("calculation", left, None, 0, len(code))
                    with self.assertRaises(VisibleDataError):
                        await reader.read_source("calculation", right, None, 0, len(code))
                    output = CalculationDataOutput(dtype="float64", shape=[], axes=[], data=1)
                    await save_calculation_data(db, left, measurement, a.source_hash, output, user=owner)
                    await save_calculation_data(db, right, other_measurement, b.source_hash, output, user=other)
                    with Catalog.open_readonly() as catalog:
                        with self.assertRaises(HTTPException) as error:
                            await library_detail(db, catalog, LibraryReference(kind="saved", calculation_id=right), owner)
                        self.assertEqual(error.exception.status_code, 404)
                    await upsert_calculations(db, [_ready_calculation(experiment, "Renamed", code, measurement, calculation_id=left, base_revision=1)], user=owner)
                    self.assertEqual(a.source_id, original_source)
                    self.assertEqual(await db.scalar(select(func.count()).select_from(CalculationData)), 2)
                    # Whitespace is meaningful: a code edit changes only this binding.
                    await upsert_calculations(db, [_ready_calculation(experiment, "Renamed", code + "\n", measurement, calculation_id=left, base_revision=2)], user=owner)
                    self.assertNotEqual(a.source_id, original_source)
                    self.assertEqual(b.source_id, original_source)
                    self.assertEqual(b.source_code, code)
                    self.assertEqual(await db.scalar(select(func.count()).select_from(CalculationData)), 1)
                    page = await list_calculations(db, CalculationListRequest(experiment_id=experiment, search_text="shared 한국어"), user=owner)
                    self.assertEqual(page["items"][0].source_id, a.source_id)
                    self.assertEqual(page["items"][0].source_code, code + "\n")
                    exact = await list_calculations(db, CalculationListRequest(experiment_id=experiment, text_filter={"source_hash": [a.source_hash]}), user=owner)
                    self.assertEqual(exact["total"], 1)
                    missing_hash = await list_calculations(db, CalculationListRequest(experiment_id=experiment, null_filter={"source_hash": "is_null"}), user=owner)
                    self.assertEqual(missing_hash["total"], 0)
                    await delete_calculations(db, [left], user=owner)
                    self.assertIsNotNone(await db.get(CalculationSource, original_source))
                    self.assertEqual(await db.scalar(select(func.count()).select_from(CalculationData)), 1)
                    self.assertEqual(await db.scalar(select(func.count()).select_from(CalculationSource)), 2)
            finally:
                await engine.dispose()
        asyncio.run(verify())
