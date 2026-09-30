"""Exercise revision 19 against a real revision-18 schema and retained results."""
import asyncio
import os
import unittest
import uuid

import asyncpg
from alembic import command
from alembic.config import Config
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from simulation.db import ExperimentRecord, Measurement, RecordedData
from db import make_async_db_url
from gpstation.db import Job, JobBatch
from gpstation.service.state import utcnow
from settings import settings
from test_calculation_database import (
    API_DIR, ORIGINAL_DB_URL, _connect_arguments, _create_database, _database_url,
    _drop_database, _seed_owners, _upgrade,
)


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class ExecutionMigrationTests(unittest.TestCase):
    async def query(self, database, sql, *args):
        connection = await asyncpg.connect(**_connect_arguments(database))
        try:
            return await connection.fetch(sql, *args)
        finally:
            await connection.close()

    def downgrade(self, database):
        settings.db_url = _database_url(database)
        try:
            command.downgrade(Config(str(API_DIR / "alembic.ini")), "000000000018")
        finally:
            settings.db_url = ORIGINAL_DB_URL

    def test_revision_19_alters_revision_18_preserves_results_and_requires_cleanup(self):
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        asyncio.run(_create_database(database))
        try:
            _upgrade(database, "head")
            owner_id, _, experiment_id, _ = asyncio.run(_seed_owners(database))

            async def seed():
                engine = create_async_engine(make_async_db_url(_database_url(database)))
                try:
                    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                        batch = JobBatch(user_id=owner_id, request_id=str(uuid.uuid4()), request_hash="retained",
                            total=1, succeeded=1, state="completed")
                        db.add(batch)
                        await db.flush()
                        job = Job(user_id=owner_id, batch_id=batch.id, item_index=1,
                            handler_type="cae", slave_app_id="cae", state="succeeded", job_mode="websocket",
                            input={"retained": "physical input"}, attempt_count=1, finished_at=utcnow())
                        db.add(job)
                        await db.flush()
                        measurement = Measurement(user_id=owner_id, experiment_id=experiment_id, job_id=job.id,
                            vars={"retained": 1}, material_snapshot={"retained": True}, recorded_at=utcnow())
                        record = ExperimentRecord(experiment_id=experiment_id, name="signal", dtype="float64",
                            tensor_order=0, contract_hash="retained", data_schema={})
                        db.add_all([measurement, record])
                        await db.flush()
                        db.add(RecordedData(user_id=owner_id, measurement_id=measurement.id,
                            experiment_record_id=record.id, data={"shape": [], "storage": {"kind": "inline", "value": 42}}))
                        await db.commit()
                        return job.id
                finally:
                    await engine.dispose()

            job_id = asyncio.run(seed())
            snapshot_sql = """
                SELECT 'batch' AS kind, to_jsonb(b) AS value FROM job_batches b
                UNION ALL SELECT 'measurement', to_jsonb(m) FROM measurements m
                UNION ALL SELECT 'result', to_jsonb(r) FROM recorded_data r
                UNION ALL SELECT 'job', to_jsonb(j) - ARRAY['attempt_id','instance_id','reservation_id','boot_id',
                    'execution_phase','cleanup_state','waiting_reason','resources','allocation'] FROM jobs j
                ORDER BY kind
            """
            baseline = asyncio.run(self.query(database, snapshot_sql))
            self.downgrade(database)
            self.assertEqual(asyncio.run(self.query(database, snapshot_sql)), baseline)
            self.assertIsNone(asyncio.run(self.query(database, "SELECT to_regclass('execution_attempts') AS name"))[0]["name"])
            columns = asyncio.run(self.query(database, "SELECT column_name FROM information_schema.columns WHERE table_name='jobs'"))
            self.assertNotIn("resources", {row["column_name"] for row in columns})

            # Revision 1 uses current ORM metadata; this round trip forces the
            # ALTER COLUMN path that a production revision-18 database needs.
            _upgrade(database, "000000000019")
            self.assertEqual(asyncio.run(self.query(database, snapshot_sql)), baseline)
            row = asyncio.run(self.query(database, "SELECT resources, allocation, attempt_id FROM jobs WHERE id=$1", uuid.UUID(job_id)))[0]
            self.assertEqual((row["resources"], row["allocation"], row["attempt_id"]), ("{}", None, None))
            columns = asyncio.run(self.query(database, "SELECT column_name FROM information_schema.columns WHERE table_name='execution_attempts'"))
            self.assertTrue({"state", "result_state", "cleanup_state"}.issubset({row["column_name"] for row in columns}))
            attempt_id = uuid.uuid4()
            asyncio.run(self.query(database, """
                INSERT INTO execution_attempts (id,job_id,attempt_count,state,resources,reservation_id,cleanup_state)
                VALUES ($1,$2,1,'finished','{}','reservation','cleaning') RETURNING id
            """, attempt_id, uuid.UUID(job_id)))
            with self.assertRaisesRegex(RuntimeError, "Clean every execution reservation"):
                self.downgrade(database)
            self.assertEqual(asyncio.run(self.query(database, "SELECT version_num FROM alembic_version"))[0]["version_num"], "000000000019")
            asyncio.run(self.query(database, "UPDATE execution_attempts SET cleaned_at=now(),cleanup_state='cleaned' WHERE id=$1 RETURNING id", attempt_id))
            self.downgrade(database)
            self.assertEqual(asyncio.run(self.query(database, snapshot_sql)), baseline)
        finally:
            asyncio.run(_drop_database(database))
