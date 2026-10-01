"""Migrate retained revision-20 data without changing execution identities or hashes."""
import asyncio
import json
import os
import unittest
import uuid

import asyncpg
from alembic import command
from alembic.config import Config

from settings import settings
from test_calculation_database import (
    API_DIR, ORIGINAL_DB_URL, _check, _connect_arguments, _create_database,
    _database_url, _drop_database, _seed_owners, _table_names, _upgrade,
)


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class OptimizationRenameMigrationTests(unittest.TestCase):
    def setUp(self):
        self.database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        asyncio.run(_create_database(self.database))
        self.addCleanup(lambda: asyncio.run(_drop_database(self.database)))
        _upgrade(self.database, "000000000020")
        owner, _, experiment, _ = asyncio.run(_seed_owners(self.database))
        self.ids = {name: str(uuid.uuid4()) for name in ("optimization", "trial", "batch", "job", "submission", "request", "retry")}
        asyncio.run(self.seed(owner, experiment))

    async def seed(self, owner, experiment):
        connection = await asyncpg.connect(**_connect_arguments(self.database))
        try:
            measurement = await connection.fetchval(
                "INSERT INTO measurements (user_id, experiment_id, vars, material_snapshot) VALUES ($1,$2,'{}','{}') RETURNING id",
                owner, experiment,
            )
            definition = json.dumps({"hash": "frozen-hash", "source_hash": "source-hash", "source_bundle": {
                "files": {"experiment.tsx": "const study_id = 'authored text';"}}, "study_id": "authored definition"})
            await connection.execute(
                "INSERT INTO cae_studies (id,user_id,experiment_id,name,request_id,request_hash,state,definition,settings,optimizer_state,best_trial_id) "
                "VALUES ($1,$2,$3,'Retained optimization',$4,'request-hash','paused',$5,'{}',$6,$7)",
                self.ids["optimization"], owner, experiment, self.ids["request"], definition,
                json.dumps({"runtime_id": "pinned-runtime", "step": 0.125}), self.ids["trial"],
            )
            await connection.execute(
                "INSERT INTO cae_trials (id,study_id,ordinal,round_index,variables,fingerprint,state,next_stage,measurement_id,result,retry_request_id,retry_requests) "
                "VALUES ($1,$2,1,0,$3,'candidate-hash','succeeded','complete',$4,$5,$6,$7)",
                self.ids["trial"], self.ids["optimization"], json.dumps({"study_id": [1, 2]}), measurement,
                json.dumps({"objective": 7, "feasible": True}), self.ids["retry"], json.dumps([self.ids["retry"]]),
            )
            await connection.execute(
                "INSERT INTO job_batches (id,user_id,request_id,request_hash,total,created_count,uploaded_count,succeeded,failed,cancelled,state,generation_stopped) "
                "VALUES ($1,$2,$3,'batch-hash',1,1,1,1,0,0,'completed',true)", self.ids["batch"], owner, str(uuid.uuid4()),
            )
            attribution = {"study_id": self.ids["optimization"], "trial_id": self.ids["trial"], "stage": "calculate"}
            await connection.execute(
                "INSERT INTO jobs (id,user_id,batch_id,item_index,handler_type,slave_app_id,job_mode,state,artifact_metadata) "
                "VALUES ($1,$2,$3,1,'cae.evaluation.calculate','evaluation','websocket','succeeded',$4)",
                self.ids["job"], owner, self.ids["batch"], json.dumps({**attribution, "study_cancel_reason": "user", "nested": {"study_id": "authored value"}}),
            )
            await connection.execute("INSERT INTO cae_batches (batch_id,experiment_id,spec) VALUES ($1,$2,$3)",
                                     self.ids["batch"], experiment, json.dumps({"study_id": self.ids["optimization"], "mode": "candidate"}))
            await connection.execute(
                "INSERT INTO cae_stage_submissions (id,trial_id,stage,generation,batch_id,job_id,state,result) VALUES ($1,$2,'calculate',1,$3,$4,'succeeded',$5)",
                self.ids["submission"], self.ids["trial"], self.ids["batch"], self.ids["job"], json.dumps(attribution),
            )
            await connection.execute(
                "INSERT INTO job_events (user_id,batch_id,job_id,type,payload) VALUES ($1,$2,$3,'job.succeeded',$4)",
                owner, self.ids["batch"], self.ids["job"], json.dumps({**attribution, "nested": {"study_id": "authored event"}}),
            )
        finally:
            await connection.close()

    async def snapshot(self, *, legacy):
        connection = await asyncpg.connect(**_connect_arguments(self.database))
        try:
            tables = ["cae_studies" if legacy else "cae_optimizations", "cae_trials", "cae_stage_submissions",
                      "jobs", "job_batches", "cae_batches", "job_events", "measurements"]
            result = {}
            for table in tables:
                rows = [json.loads(row[0]) for row in await connection.fetch(f"SELECT to_jsonb(t) FROM {table} t")]
                if table == "jobs":
                    # Revision 22 owns target placement. The evolving baseline
                    # may already expose its nullable column at revision 20.
                    for row in rows:
                        row.pop("target_launcher_id", None)
                if legacy:
                    for row in rows:
                        if table == "cae_trials":
                            row["optimization_id"] = row.pop("study_id")
                        column = {"jobs": "artifact_metadata", "cae_batches": "spec", "job_events": "payload", "cae_stage_submissions": "result"}.get(table)
                        if column:
                            value = row[column]
                            for old, new in (("study_id", "optimization_id"), ("study_cancel_reason", "optimization_cancel_reason")):
                                if old in value:
                                    value[new] = value.pop(old)
                result["cae_optimizations" if table == "cae_studies" else table] = rows
            return result
        finally:
            await connection.close()

    def test_retained_data_and_hashes_survive_upgrade_and_round_trip(self):
        before = asyncio.run(self.snapshot(legacy=True))
        for _ in range(2):
            _upgrade(self.database, "head")
            self.assertEqual(asyncio.run(self.snapshot(legacy=False)), before)
            self.assertNotIn("cae_studies", asyncio.run(_table_names(self.database)))
            _check(self.database)
            settings.db_url = _database_url(self.database)
            try:
                command.downgrade(Config(str(API_DIR / "alembic.ini")), "000000000020")
            finally:
                settings.db_url = ORIGINAL_DB_URL
            self.assertEqual(asyncio.run(self.snapshot(legacy=True)), before)

    def test_conflicting_metadata_aborts_without_partial_rename(self):
        async def conflict():
            connection = await asyncpg.connect(**_connect_arguments(self.database))
            try:
                await connection.execute("UPDATE job_events SET payload = payload || $1::jsonb",
                                         json.dumps({"optimization_id": str(uuid.uuid4())}))
            finally:
                await connection.close()

        asyncio.run(conflict())
        with self.assertRaisesRegex(RuntimeError, "Conflicting study_id/optimization_id"):
            _upgrade(self.database, "head")
        self.assertIn("cae_studies", asyncio.run(_table_names(self.database)))
        self.assertNotIn("cae_optimizations", asyncio.run(_table_names(self.database)))

        async def unchanged_metadata():
            connection = await asyncpg.connect(**_connect_arguments(self.database))
            try:
                return json.loads(await connection.fetchval("SELECT artifact_metadata FROM jobs WHERE id=$1", self.ids["job"]))
            finally:
                await connection.close()

        metadata = asyncio.run(unchanged_metadata())
        self.assertEqual(metadata["study_id"], self.ids["optimization"])
        self.assertNotIn("optimization_id", metadata)
