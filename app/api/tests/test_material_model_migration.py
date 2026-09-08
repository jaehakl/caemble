"""Opt-in migration tests use a disposable database, never the application DB."""

import asyncio
import os
import unittest
import uuid

import asyncpg
from alembic import command
from alembic.config import Config

from test_calculation_database import (
    API_DIR, ORIGINAL_DB_URL, _check, _connect_arguments, _create_database,
    _database_url, _drop_database, _seed_owners, _upgrade,
)
from settings import settings


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL migration tests.")
class MaterialModelMigrationTests(unittest.TestCase):
    def test_reset_drains_only_cae_and_retains_accounts_and_unrelated_jobs(self):
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        try:
            asyncio.run(_create_database(database))
            _upgrade(database, "head")
            _check(database)
            owner_id, _, experiment_id, _ = asyncio.run(_seed_owners(database))
            cae_job, ai_job = str(uuid.uuid4()), str(uuid.uuid4())
            upload_batch, ai_batch = uuid.uuid4(), uuid.uuid4()
            launcher_id = uuid.uuid4()
            descendants = (
                "experiment_demos", "measurements", "experiment_records", "recorded_data",
                "calculations", "calculation_experiment_records", "calculation_data",
            )
            legacy_tables = ("materials", "material_names", "material_parameters", "material_parameter_qualifiers")
            preserved_tables = ("users", "experiment_namespaces", "api_keys", "launchers", "identities", "sessions", "roles", "user_roles", "auth_audit")

            async def seed_legacy():
                connection = await asyncpg.connect(**_connect_arguments(database))
                try:
                    await connection.execute("ALTER TABLE measurements RENAME COLUMN material_snapshot TO material_parameters")
                    await connection.execute("CREATE TABLE materials (id serial primary key)")
                    await connection.execute("CREATE TABLE material_names (id serial primary key, material_id integer REFERENCES materials(id))")
                    await connection.execute("CREATE TABLE material_parameters (id serial primary key, material_id integer REFERENCES materials(id))")
                    await connection.execute("CREATE TABLE material_parameter_qualifiers (id serial primary key, material_parameter_id integer REFERENCES material_parameters(id))")
                    material_id = await connection.fetchval("INSERT INTO materials DEFAULT VALUES RETURNING id")
                    await connection.execute("INSERT INTO material_names (material_id) VALUES ($1)", material_id)
                    parameter_id = await connection.fetchval("INSERT INTO material_parameters (material_id) VALUES ($1) RETURNING id", material_id)
                    await connection.execute("INSERT INTO material_parameter_qualifiers (material_parameter_id) VALUES ($1)", parameter_id)
                    await connection.execute("INSERT INTO api_keys (id,user_id,key_prefix,key_hash,scopes) VALUES ($1,$2,'migration-test',$3,'[\"caemble\"]')", uuid.uuid4(), uuid.UUID(owner_id), b"test-api-key-hash")
                    await connection.execute("INSERT INTO launchers (id,user_id,launcher_name,status,connected_at,last_heartbeat_at) VALUES ($1,$2,'retained-launcher','idle',now(),now())", launcher_id, uuid.UUID(owner_id))
                    await connection.execute("INSERT INTO identities (id,user_id,provider,provider_user_id) VALUES ($1,$2,'google','migration-test-subject')", uuid.uuid4(), uuid.UUID(owner_id))
                    await connection.execute("INSERT INTO sessions (id,user_id,session_id_hash) VALUES ($1,$2,$3)", uuid.uuid4(), uuid.UUID(owner_id), b"test-session-hash")
                    role_id = await connection.fetchval("SELECT id FROM roles WHERE name='user'")
                    self.assertIsNotNone(role_id)
                    await connection.execute("INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2)", uuid.UUID(owner_id), role_id)
                    await connection.execute("INSERT INTO auth_audit (id,user_id,event) VALUES ($1,$2,'login.success')", uuid.uuid4(), uuid.UUID(owner_id))
                    for batch_id, state in ((upload_batch, "uploading"), (ai_batch, "running")):
                        await connection.execute("INSERT INTO job_batches (id,user_id,request_id,request_hash,total,state) VALUES ($1,$2,$3,'migration-test',1,$4)", batch_id, uuid.UUID(owner_id), uuid.uuid4(), state)
                    await connection.execute("INSERT INTO cae_batches (batch_id,experiment_id,spec) VALUES ($1,$2,'{}')", upload_batch, experiment_id)
                    for job_id, handler, app_id, state in ((cae_job, "cae.simulation", "cae", "running"), (ai_job, "ai.chat", "ai", "running")):
                        await connection.execute("INSERT INTO jobs (id,user_id,handler_type,slave_app_id,state) VALUES ($1,$2,$3,$4,$5)", uuid.UUID(job_id), uuid.UUID(owner_id), handler, app_id, state)
                    await connection.execute("UPDATE jobs SET batch_id=$1 WHERE id=$2", ai_batch, uuid.UUID(ai_job))
                    await connection.execute("UPDATE jobs SET launcher_id=$1 WHERE id=$2", launcher_id, uuid.UUID(cae_job))
                    measurement_id = await connection.fetchval("INSERT INTO measurements (user_id,experiment_id,vars,material_parameters,job_id) VALUES ($1,$2,'{}','{}',$3) RETURNING id", uuid.UUID(owner_id), experiment_id, uuid.UUID(cae_job))
                    await connection.execute("INSERT INTO experiment_demos (experiment_id,display_order,is_default) VALUES ($1,0,true)", experiment_id)
                    record_id = await connection.fetchval("INSERT INTO experiment_records (experiment_id,name,tensor_order,dtype,data_schema,contract_hash) VALUES ($1,'signal',0,'float64','{}','migration-contract') RETURNING id", experiment_id)
                    await connection.execute("INSERT INTO recorded_data (user_id,measurement_id,experiment_record_id,data) VALUES ($1,$2,$3,'7')", uuid.UUID(owner_id), measurement_id, record_id)
                    calculation_id = await connection.fetchval("INSERT INTO calculations (experiment_id,name,source_code,source_hash,preflight_measurement_id) VALUES ($1,'read-signal','export default 7','calculation-hash',$2) RETURNING id", experiment_id, measurement_id)
                    await connection.execute("INSERT INTO calculation_experiment_records (calculation_id,experiment_record_id) VALUES ($1,$2)", calculation_id, record_id)
                    await connection.execute("INSERT INTO calculation_data (calculation_id,measurement_id,data) VALUES ($1,$2,'{\"signal\":7}')", calculation_id, measurement_id)
                    return {table: await connection.fetch(f"SELECT * FROM {table} ORDER BY 1") for table in preserved_tables}
                finally:
                    await connection.close()

            preserved_rows = asyncio.run(seed_legacy())
            settings.db_url = _database_url(database)
            command.stamp(Config(str(API_DIR / "alembic.ini")), "000000000007")
            settings.db_url = ORIGINAL_DB_URL
            with self.assertRaisesRegex(RuntimeError, "Drain or cancel"):
                _upgrade(database, "head")

            async def drain_and_check_rollback():
                connection = await asyncpg.connect(**_connect_arguments(database))
                try:
                    self.assertEqual(await connection.fetchval("SELECT count(*) FROM experiments"), 2)
                    for table in (*descendants, *legacy_tables):
                        self.assertEqual(await connection.fetchval(f"SELECT count(*) FROM {table}"), 1, table)
                    await connection.execute("UPDATE jobs SET state='failed' WHERE id=$1", uuid.UUID(cae_job))
                finally:
                    await connection.close()

            asyncio.run(drain_and_check_rollback())
            with self.assertRaisesRegex(RuntimeError, "Drain or cancel"):
                _upgrade(database, "head")

            async def cancel_upload():
                connection = await asyncpg.connect(**_connect_arguments(database))
                try:
                    self.assertEqual(await connection.fetchval("SELECT count(*) FROM measurements"), 1)
                    await connection.execute("UPDATE job_batches SET state='cancelled' WHERE id=$1", upload_batch)
                finally:
                    await connection.close()

            asyncio.run(cancel_upload())
            _upgrade(database, "head")
            _check(database)

            async def verify():
                connection = await asyncpg.connect(**_connect_arguments(database))
                try:
                    self.assertEqual(await connection.fetchval("SELECT count(*) FROM experiments"), 0)
                    for table in descendants:
                        self.assertEqual(await connection.fetchval(f"SELECT count(*) FROM {table}"), 0, table)
                    self.assertIsNone(await connection.fetchval("SELECT id FROM jobs WHERE id=$1", uuid.UUID(cae_job)))
                    self.assertEqual(await connection.fetchval("SELECT state FROM jobs WHERE id=$1", uuid.UUID(ai_job)), "running")
                    self.assertEqual(await connection.fetchval("SELECT state FROM job_batches WHERE id=$1", ai_batch), "running")
                    self.assertIsNone(await connection.fetchval("SELECT id FROM job_batches WHERE id=$1", upload_batch))
                    self.assertEqual(await connection.fetchval("SELECT count(*) FROM cae_batches"), 0)
                    for table, expected in preserved_rows.items():
                        self.assertEqual(await connection.fetch(f"SELECT * FROM {table} ORDER BY 1"), expected, table)
                    for table in legacy_tables:
                        self.assertIsNone(await connection.fetchval("SELECT to_regclass($1)", f"public.{table}"), table)
                    self.assertEqual(await connection.fetchval("SELECT count(*) FROM information_schema.columns WHERE table_name='measurements' AND column_name='material_snapshot'"), 1)
                finally:
                    await connection.close()

            asyncio.run(verify())
        finally:
            settings.db_url = ORIGINAL_DB_URL
            asyncio.run(_drop_database(database))
