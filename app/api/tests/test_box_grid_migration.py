"""Opt-in migration checks use a disposable, name-fenced PostgreSQL database."""
import asyncio
import json
import os
import unittest
import uuid

import asyncpg

from test_calculation_database import _connect_arguments, _create_database, _drop_database, _seed_owners, _upgrade


@unittest.skipUnless(os.getenv("RUN_CALCULATION_DB_TESTS") == "1", "Requires disposable PostgreSQL databases")
class BoxGridMigrationTests(unittest.TestCase):
    def test_resets_results_and_tombstones_only_result_objects(self):
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        created = False
        try:
            asyncio.run(_create_database(database))
            created = True
            _upgrade(database, "000000000011")
            owner, _, experiment, _ = asyncio.run(_seed_owners(database))
            async def seed():
                connection = await asyncpg.connect(**_connect_arguments(database))
                try:
                    # The baseline imports current ORM metadata. Remove these
                    # new empty tables to exercise the real upgrade DDL path.
                    await connection.execute("DROP TABLE job_visualizations")
                    await connection.execute("DROP TABLE measurement_visualizations")
                    source = await connection.fetchval("SELECT source_bundle::text FROM experiments WHERE id=$1", experiment)
                    measurement = await connection.fetchval("INSERT INTO measurements (user_id,experiment_id,vars,material_snapshot,recorded_at) VALUES ($1,$2,'{\"radius\":2}','{\"saved\":true}',CURRENT_TIMESTAMP) RETURNING id", uuid.UUID(owner), experiment)
                    record = await connection.fetchval("INSERT INTO experiment_records (experiment_id,name,tensor_order,dtype,data_schema,contract_hash) VALUES ($1,'oldMesh',0,'float64','{}','old') RETURNING id", experiment)
                    await connection.execute("INSERT INTO recorded_data (user_id,measurement_id,experiment_record_id,data) VALUES ($1,$2,$3,'{\"old\":true}')", uuid.UUID(owner), measurement, record)
                    calculation = await connection.fetchval("INSERT INTO calculations (experiment_id,name,source_code,source_hash,output_layout,preflight_measurement_id,contract_status,revision) VALUES ($1,'saved','source stays','hash','{}',$2,'ready',3) RETURNING id", experiment, measurement)
                    await connection.execute("INSERT INTO calculation_experiment_records (calculation_id,experiment_record_id) VALUES ($1,$2)", calculation, record)
                    await connection.execute("INSERT INTO calculation_data (calculation_id,measurement_id,data) VALUES ($1,$2,'{}')", calculation, measurement)
                    await connection.execute("UPDATE experiments SET result_contracts='{\"oldMesh\":{}}' WHERE id=$1", experiment)
                    metadata_cases = (
                        ("object", '{"recorded_data":{},"visualizations":[],"execution_trace":[],"inputHash":"keep"}'),
                        ("empty_object", "{}"),
                        ("sql_null", None),
                        ("json_null", "null"),
                        ("string", '"recorded_data"'),
                        ("number", "42"),
                        ("boolean", "true"),
                        ("array", '["recorded_data","visualizations","execution_trace",{"keep":true}]'),
                    )
                    jobs = []
                    for handler in ("cae.simulation", "other.handler"):
                        for case, metadata in metadata_cases:
                            job_id = uuid.uuid4()
                            await connection.execute(
                                "INSERT INTO jobs (id,user_id,handler_type,slave_app_id,state,attempt_count,input,artifact_metadata) VALUES ($1,$2,$3,'cae','succeeded',1,'{\"preflight\":true}',$4::jsonb)",
                                job_id, uuid.UUID(owner), handler, metadata,
                            )
                            expected = '{"inputHash":"keep"}' if handler == "cae.simulation" and case == "object" else metadata
                            jobs.append((job_id, handler, case, expected))
                    job_id = jobs[0][0]
                    for purpose in ("record", "calculation", "layout", "measurement", "input"):
                        await connection.execute("INSERT INTO storage_objects (id,user_id,experiment_id,measurement_id,job_id,attempt,purpose,manifest,ready,bound) VALUES ($1,$2,$3,$4,$5,1,$6,'{}',true,true)", uuid.uuid4(), uuid.UUID(owner), experiment, measurement, job_id, purpose)
                    return source, measurement, calculation, jobs
                finally:
                    await connection.close()
            source, measurement, calculation, jobs = asyncio.run(seed())
            _upgrade(database, "head")
            async def verify():
                connection = await asyncpg.connect(**_connect_arguments(database))
                try:
                    self.assertEqual(await connection.fetchval("SELECT version_num FROM alembic_version"), "000000000012")
                    for table in ("recorded_data", "calculation_data", "calculation_experiment_records", "experiment_records", "measurement_visualizations", "job_visualizations"):
                        self.assertEqual(await connection.fetchval(f"SELECT count(*) FROM {table}"), 0)
                    row = await connection.fetchrow("SELECT vars::text,material_snapshot::text,recorded_at FROM measurements WHERE id=$1", measurement)
                    self.assertEqual(json.loads(row["vars"]), {"radius": 2})
                    self.assertEqual(json.loads(row["material_snapshot"]), {"saved": True})
                    self.assertIsNone(row["recorded_at"])
                    self.assertEqual(await connection.fetchval("SELECT source_bundle::text FROM experiments WHERE id=$1", experiment), source)
                    self.assertEqual(await connection.fetchval("SELECT result_contracts::text FROM experiments WHERE id=$1", experiment), "{}")
                    row = await connection.fetchrow("SELECT source_code,source_hash,contract_status,output_layout,preflight_measurement_id,revision FROM calculations WHERE id=$1", calculation)
                    self.assertEqual(tuple(row), ("source stays", "hash", "needs_preflight", None, None, 4))
                    for row in await connection.fetch("SELECT purpose,deleting,bound FROM storage_objects"):
                        discarded = row["purpose"] in {"record", "calculation", "layout"}
                        self.assertEqual(row["deleting"], discarded)
                        self.assertEqual(row["bound"], not discarded)
                    for job_id, handler, case, expected in jobs:
                        with self.subTest(handler=handler, metadata=case):
                            metadata = await connection.fetchval("SELECT artifact_metadata::text FROM jobs WHERE id=$1", job_id)
                            if expected is None:
                                self.assertIsNone(metadata)
                            else:
                                # SQL NULL must remain distinct from the JSON text "null".
                                self.assertIsNotNone(metadata)
                                self.assertEqual(json.loads(metadata), json.loads(expected))
                finally:
                    await connection.close()
            asyncio.run(verify())
        finally:
            if created:
                asyncio.run(_drop_database(database))
