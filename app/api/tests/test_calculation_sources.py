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
from models import CalculationDataOutput, CalculationListRequest, CalculationMetadataUpdate, RoleEnum, UserData
from service.calculation import delete_calculations, list_calculations, upsert_calculations, update_calculation_metadata
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
                rows = await connection.fetch("SELECT c.*, s.source_code, s.source_hash, s.name, s.description FROM calculations c JOIN calculation_sources s ON s.id = c.source_id ORDER BY c.id")
                self.assertEqual(rows[0]["source_id"], rows[1]["source_id"])
                for old, row in zip(before, rows):
                    self.assertEqual({k: v for k, v in old.items() if k not in ("name", "description")}, {key: row[key] for key in old if key not in ("name", "description")})
                self.assertEqual(await connection.fetchval("SELECT calculation_id FROM calculation_data WHERE id = $1", data_id), ids[0])
                self.assertEqual(await connection.fetchval("SELECT experiment_record_id FROM calculation_experiment_records WHERE calculation_id = $1", ids[0]), record_id)
                reference = await connection.fetchrow("SELECT calculation_id, calculation_data_id, bound, deleting FROM storage_objects WHERE id = $1", object_id)
                self.assertEqual(tuple(reference), (ids[0], data_id, True, False))
                self.assertEqual(rows[0]["name"], before[0]["name"])
                self.assertEqual(rows[1]["name"], before[0]["name"])
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

    def test_concurrent_reuse_shared_edits_contract_fork_and_permissions(self):
        async def verify():
            owner_id, other_id, experiment, other_experiment, measurement, _, _, other_measurement = await _seed_calculation_data(self.database)
            owner = UserData(id=owner_id, roles=[RoleEnum.user, RoleEnum.admin])
            other = UserData(id=other_id, roles=[RoleEnum.user])
            engine = create_async_engine(make_async_db_url(_database_url(self.database)))
            sessions = async_sessionmaker(engine, expire_on_commit=False)
            code = '/* @caemble-contract {"version":1,"inputs":{},"output":{"dtype":"float64","shape":[]}} */\nexport default function calculate(input) { return {dtype:"float64", data:1}; }'
            async def save(target, preflight, name):
                async with sessions() as db:
                    return (await upsert_calculations(db, [_ready_calculation(target, name, code, preflight)], user=owner))[0]["id"]
            try:
                left, right = await asyncio.gather(save(experiment, measurement, "Left"), save(other_experiment, other_measurement, "Right"))
                async with sessions() as db:
                    a, b = await db.get(Calculation, left), await db.get(Calculation, right)
                    original_source = a.source_id
                    self.assertEqual(original_source, b.source_id)
                    self.assertEqual(await db.scalar(select(func.count()).select_from(CalculationSource)), 1)
                    output = CalculationDataOutput(dtype="float64", shape=[], axes=[], data=1)
                    await save_calculation_data(db, left, measurement, a.source_hash, output, user=owner, source_revision=1)
                    await save_calculation_data(db, right, other_measurement, b.source_hash, output, user=other, source_revision=1)
                    denied = _ready_calculation(other_experiment, "Forbidden", code, other_measurement, calculation_id=right).model_copy(update={"base_source_revision": 1})
                    async with sessions() as denied_db:
                        with self.assertRaises(HTTPException) as error:
                            await upsert_calculations(denied_db, [denied], user=other)
                        self.assertEqual(error.exception.status_code, 403)
                        await denied_db.rollback()
                    renamed = _ready_calculation(experiment, "Renamed", code, measurement, calculation_id=left).model_copy(update={"base_source_revision": 1})
                    await upsert_calculations(db, [renamed], user=owner)
                    self.assertEqual(b.name, "Renamed")
                    self.assertEqual(await db.scalar(select(func.count()).select_from(CalculationData)), 2)
                    edited = renamed.model_copy(update={"source_code": code + "\n", "source_hash": hashlib.sha256((code + "\n").encode()).hexdigest(), "base_revision": a.revision, "base_source_revision": 2})
                    await upsert_calculations(db, [edited], user=owner)
                    self.assertEqual(a.source_id, original_source)
                    self.assertEqual(b.source_code, code + "\n")
                    self.assertEqual(b.contract_status, "needs_preflight")
                    self.assertIsNone(b.preflight_measurement_id)
                    self.assertEqual(await db.scalar(select(func.count()).select_from(CalculationData)), 0)
                    async with sessions() as stale_db:
                        with self.assertRaises(HTTPException):
                            await save_calculation_data(stale_db, left, measurement, a.source_hash, output, user=owner, source_revision=2)
                        await stale_db.rollback()
                    fork_code = code.replace('"shape":[]', '"shape":[],"min":0')
                    fork = edited.model_copy(update={"source_code": fork_code, "source_hash": hashlib.sha256(fork_code.encode()).hexdigest(), "base_revision": a.revision, "base_source_revision": 3})
                    await upsert_calculations(db, [fork], user=owner)
                    self.assertNotEqual(a.source_id, original_source)
                    self.assertEqual(b.source_id, original_source)
                    self.assertEqual(b.source_code, code + "\n")
                    page = await list_calculations(db, CalculationListRequest(experiment_id=experiment), user=owner)
                    self.assertEqual(page["items"][0].source_id, a.source_id)
                    await update_calculation_metadata(db, right, CalculationMetadataUpdate(
                        name="Shared without preflight", base_source_revision=3), user=owner)
                    self.assertEqual(b.name, "Shared without preflight")
                    self.assertEqual(b.contract_status, "needs_preflight")
                    await delete_calculations(db, [left], user=owner)
                    self.assertIsNotNone(await db.get(CalculationSource, original_source))
            finally:
                await engine.dispose()
        asyncio.run(verify())
