"""The additive migration preserves legacy rows and does not invent semantics."""
import asyncio
import os
import unittest
import uuid

import asyncpg

from test_calculation_database import _connect_arguments, _create_database, _drop_database, _seed_owners, _upgrade


@unittest.skipUnless(os.getenv("RUN_CALCULATION_DB_TESTS") == "1", "Requires disposable PostgreSQL databases")
class ResultContractMigrationTests(unittest.TestCase):
    def test_old_rows_survive_without_inferred_contract(self):
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        try:
            asyncio.run(_create_database(database))
            _upgrade(database, "000000000009")
            owner, _, experiment, _ = asyncio.run(_seed_owners(database))

            async def seed():
                connection = await asyncpg.connect(**_connect_arguments(database))
                try:
                    # The initial migration imports current metadata; reproduce the old column layout.
                    await connection.execute("ALTER TABLE experiments DROP COLUMN IF EXISTS result_contracts")
                    measurement = await connection.fetchval("INSERT INTO measurements (user_id,experiment_id,vars,material_snapshot) VALUES ($1,$2,'{}','{}') RETURNING id", uuid.UUID(owner), experiment)
                    record = await connection.fetchval("INSERT INTO experiment_records (experiment_id,name,tensor_order,dtype,data_schema,contract_hash) VALUES ($1,'rayPaths',0,'float64','{}','legacy') RETURNING id", experiment)
                    return await connection.fetchval("INSERT INTO recorded_data (user_id,measurement_id,experiment_record_id,data) VALUES ($1,$2,$3,'7') RETURNING id", uuid.UUID(owner), measurement, record)
                finally:
                    await connection.close()

            recorded = asyncio.run(seed())
            _upgrade(database, "head")

            async def verify():
                connection = await asyncpg.connect(**_connect_arguments(database))
                try:
                    self.assertEqual(await connection.fetchval("SELECT data::text FROM recorded_data WHERE id=$1", recorded), "7")
                    self.assertIsNone(await connection.fetchval("SELECT result_contracts FROM experiments WHERE id=$1", experiment))
                    self.assertEqual(await connection.fetchval("SELECT contract_hash FROM experiment_records WHERE experiment_id=$1", experiment), "legacy")
                finally:
                    await connection.close()

            asyncio.run(verify())
        finally:
            asyncio.run(_drop_database(database))
