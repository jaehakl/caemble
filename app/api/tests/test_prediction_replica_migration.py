"""Upgrade a populated, genuine revision-23 schema without touching saved files."""
import asyncio
import json
import os
import unittest
from uuid import uuid4

import asyncpg

from test_calculation_database import _check, _connect_arguments, _create_database, _drop_database, _seed_owners, _upgrade


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class PredictionReplicaMigrationTests(unittest.TestCase):
    def test_revision_23_locations_revision_history_and_pending_work_survive(self):
        database = f"caemble_calculation_test_{uuid4().hex}"
        asyncio.run(_create_database(database))
        try:
            _upgrade(database, "000000000023")
            owner, _, experiment_id, _ = asyncio.run(_seed_owners(database))
            storage_id, launcher_id, dataset_id, model_id = (uuid4() for _ in range(4))
            first_request, pending_request = uuid4(), uuid4()
            artifact = {"manifest_sha256": "a" * 64, "files": [{"name": "model.json", "sha256": "b" * 64, "byteLength": 12}],
                "profile": {}, "input_layouts": [], "output_layouts": [], "format_version": 1}

            async def seed():
                connection = await asyncpg.connect(**_connect_arguments(database))
                try:
                    await connection.execute("""INSERT INTO prediction_storages (storage_id,user_id,launcher_id,name)
                        VALUES ($1,$2,$3,'기존 연구실 PC')""", storage_id, owner, launcher_id)
                    await connection.execute("""INSERT INTO prediction_datasets
                        (id,user_id,experiment_id,name,state,source_kind,selection,current_revision,storage_id,launcher_id)
                        VALUES ($1,$2,$3,'학습 데이터','active','local','{}',2,$4,$5)""",
                        dataset_id, owner, experiment_id, storage_id, launcher_id)
                    for revision in (1, 2):
                        await connection.execute("""INSERT INTO prediction_dataset_revisions
                            (dataset_id,revision,request_id,request_hash,fingerprint,summary,payload)
                            VALUES ($1,$2,$3,'request',$4,$5::jsonb,$6::jsonb)""", dataset_id, revision, uuid4(),
                            "sha256:" + str(revision) * 64, json.dumps({"manifest_sha256": str(revision) * 64}),
                            '{}' if revision == 2 else None)
                    await connection.execute("""INSERT INTO prediction_models
                        (id,user_id,experiment_id,name,direction,state,current_revision,storage_id,launcher_id)
                        VALUES ($1,$2,$3,'온도 모델','forward','active',1,$4,$5)""",
                        model_id, owner, experiment_id, storage_id, launcher_id)
                    for revision, request, state in ((1, first_request, "ready"), (2, pending_request, "reserved")):
                        await connection.execute("""INSERT INTO prediction_model_revisions
                            (model_id,revision,request_id,request_hash,state,dataset_id,dataset_revision,dataset_fingerprint,
                             definition,source_contracts,artifact)
                            VALUES ($1,$2,$3,'request',$4,$5,1,$6,'{}','{}',$7::jsonb)""",
                            model_id, revision, request, state, dataset_id, "sha256:" + "1" * 64,
                            json.dumps(artifact) if state == "ready" else None)
                finally:
                    await connection.close()

            asyncio.run(seed())
            _upgrade(database, "head")
            _check(database)

            async def inspect():
                connection = await asyncpg.connect(**_connect_arguments(database))
                try:
                    model = await connection.fetchrow("SELECT * FROM prediction_models WHERE id=$1", model_id)
                    self.assertEqual((model["id"], model["name"], model["current_revision"]), (model_id, "온도 모델", 1))
                    self.assertNotIn("storage_id", model)
                    copies = await connection.fetch("SELECT * FROM prediction_replicas WHERE model_id=$1", model_id)
                    self.assertEqual(len(copies), 1)
                    self.assertEqual((copies[0]["revision"], copies[0]["storage_id"], copies[0]["state"]), (1, storage_id, "unverified"))
                    self.assertIsNone(copies[0]["verified_at"])
                    self.assertEqual(json.loads(copies[0]["artifact"]), artifact)
                    datasets = await connection.fetch("SELECT revision,state FROM prediction_replicas WHERE dataset_id=$1", dataset_id)
                    self.assertEqual([(row["revision"], row["state"]) for row in datasets], [(2, "unverified")])
                    access = await connection.fetchrow("SELECT * FROM prediction_storage_accesses WHERE storage_id=$1", storage_id)
                    self.assertEqual(access["launcher_id"], launcher_id)
                    pending = await connection.fetchrow("SELECT * FROM prediction_operations WHERE id=$1", pending_request)
                    self.assertEqual((pending["kind"], pending["state"], pending["revision"]), ("prepare", "interrupted", 2))
                    self.assertEqual(json.loads(pending["details"])["target_storage_id"], str(storage_id))
                    self.assertEqual(await connection.fetchval("SELECT count(*) FROM prediction_model_revisions WHERE model_id=$1", model_id), 2)
                finally:
                    await connection.close()

            asyncio.run(inspect())
        finally:
            asyncio.run(_drop_database(database))
