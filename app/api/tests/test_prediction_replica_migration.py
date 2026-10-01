"""Upgrade revision-23 data and validate API DTOs against the real UI schemas.

The opted-in database test also needs Node with native TypeScript support and
the installed app/ui dependencies. Saved artifact files are never modified.
"""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

import asyncpg
from fastapi.encoders import jsonable_encoder
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from test_calculation_database import _check, _connect_arguments, _create_database, _database_url, _drop_database, _seed_owners, _upgrade
from db import make_async_db_url
from prediction.datasets import list_datasets
from prediction.db import ModelLease, Operation, Replica
from prediction.lifecycle import list_storages
from prediction.models import complete_model, list_models
from prediction.operations import create_operation, list_operations, stop_operation
from prediction.replicas import check_replica
from prediction.schemas import ModelComplete, OperationCreate, ReplicaRegistration
from settings import settings


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class PredictionReplicaMigrationTests(unittest.TestCase):
    def test_revision_23_locations_revision_history_and_pending_work_survive(self):
        database = f"caemble_calculation_test_{uuid4().hex}"
        asyncio.run(_create_database(database))
        try:
            _upgrade(database, "000000000023")
            owner, _, experiment_id, _ = asyncio.run(_seed_owners(database))
            # These inputs make migration 24 emit IDs whose version/variant bits
            # fail RFC UUID validation, although PostgreSQL UUID accepts them.
            model_id = UUID("11111111-1111-4111-8111-111111111111")
            storage_id = UUID("22222222-2222-4222-8222-222222222222")
            dataset_id = UUID("44444444-4444-4444-8444-444444444444")
            server_dataset_id = UUID("55555555-5555-4555-8555-555555555555")
            launcher_id = UUID("66666666-6666-4666-8666-666666666666")
            deleting_model_id = UUID("77777777-7777-4777-8777-777777777777")
            deletion_id = UUID("88888888-8888-4888-8888-888888888888")
            job_id = uuid4()
            first_request, pending_request = uuid4(), uuid4()
            replica_id = UUID(hashlib.md5(f"model/{model_id}/1/{storage_id}".encode()).hexdigest())
            server_storage_id = UUID(hashlib.md5(f"api-dataset/{owner}".encode()).hexdigest())
            server_replica_id = UUID(hashlib.md5(f"server-dataset/{server_dataset_id}/1".encode()).hexdigest())
            deleting_replica_id = UUID(hashlib.md5(f"model/{deleting_model_id}/1/{storage_id}".encode()).hexdigest())
            self.assertEqual(str(replica_id), "5b42b8de-3de3-b05d-ea6f-1274e1a2a93a")
            artifact = {"manifest_sha256": "a" * 64, "files": [{"name": "model.json", "sha256": "b" * 64, "byteLength": 12}],
                "profile": {}, "input_layouts": [], "output_layouts": [], "format_version": 1}

            async def seed():
                connection = await asyncpg.connect(**_connect_arguments(database))
                try:
                    await connection.execute("""INSERT INTO launchers
                        (id,user_id,installation_id,launcher_name,status,connected_at,last_heartbeat_at,slave_app_ids)
                        VALUES ($1,$2,$3,'기존 연구실 PC','ready',now(),now(),'["predictor"]'::jsonb)""",
                        launcher_id, owner, str(uuid4()))
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
                    await connection.execute("""INSERT INTO prediction_datasets
                        (id,user_id,experiment_id,name,state,source_kind,selection,current_revision)
                        VALUES ($1,$2,$3,'서버 학습 데이터','active','server','{}',1)""",
                        server_dataset_id, owner, experiment_id)
                    await connection.execute("""INSERT INTO prediction_dataset_revisions
                        (dataset_id,revision,request_id,request_hash,fingerprint,summary,payload)
                        VALUES ($1,1,$2,'server-request',$3,'{"sample_count":0}','{"measurements":[]}')""",
                        server_dataset_id, uuid4(), "sha256:" + "3" * 64)
                    await connection.execute("""INSERT INTO prediction_models
                        (id,user_id,experiment_id,name,direction,state,current_revision,storage_id,launcher_id)
                        VALUES ($1,$2,$3,'온도 모델','forward','active',1,$4,$5)""",
                        model_id, owner, experiment_id, storage_id, launcher_id)
                    for revision, request, state in ((1, first_request, "ready"), (2, pending_request, "reserved")):
                        await connection.execute("""INSERT INTO prediction_model_revisions
                            (model_id,revision,request_id,request_hash,state,dataset_id,dataset_revision,dataset_fingerprint,
                             definition,source_contracts,artifact)
                            VALUES ($1,$2,$3,'request',$4,$5,1,$6,'{"fingerprint":"existing-definition"}','{}',$7::jsonb)""",
                            model_id, revision, request, state, dataset_id, "sha256:" + "1" * 64,
                            json.dumps(artifact) if state == "ready" else None)
                    await connection.execute("""INSERT INTO jobs
                        (id,user_id,launcher_id,handler_type,slave_app_id,state)
                        VALUES ($1,$2,$3,'prediction.session','predictor','running')""", job_id, owner, launcher_id)
                    await connection.executemany("""INSERT INTO prediction_model_leases (model_id,revision,job_id)
                        VALUES ($1,$2,$3)""", [(model_id, revision, job_id) for revision in (1, 2)])
                    await connection.execute("""INSERT INTO prediction_models
                        (id,user_id,experiment_id,name,direction,state,current_revision,storage_id,launcher_id,delete_id)
                        VALUES ($1,$2,$3,'삭제 대기 모델','forward','deleting',1,$4,$5,$6)""",
                        deleting_model_id, owner, experiment_id, storage_id, launcher_id, deletion_id)
                    await connection.execute("""INSERT INTO prediction_model_revisions
                        (model_id,revision,request_id,request_hash,state,dataset_id,dataset_revision,dataset_fingerprint,
                         definition,source_contracts,artifact)
                        VALUES ($1,1,$2,'deleting-request','ready',$3,1,$4,
                            '{"fingerprint":"deleting-definition"}','{}',$5::jsonb)""",
                        deleting_model_id, uuid4(), dataset_id, "sha256:" + "1" * 64, json.dumps(artifact))
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
                    self.assertEqual(copies[0]["id"], replica_id)
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
                    server = await connection.fetchrow("SELECT * FROM prediction_replicas WHERE dataset_id=$1", server_dataset_id)
                    self.assertEqual((server["id"], server["storage_id"]), (server_replica_id, server_storage_id))
                    leases = await connection.fetch("SELECT * FROM prediction_model_leases WHERE model_id=$1 ORDER BY revision", model_id)
                    self.assertEqual([(row["storage_id"], row["replica_id"]) for row in leases],
                        [(storage_id, replica_id), (storage_id, None)])
                    deletion = await connection.fetchrow("SELECT * FROM prediction_operations WHERE id=$1", deletion_id)
                    self.assertEqual(json.loads(deletion["details"])["replica_ids"], [str(deleting_replica_id)])
                finally:
                    await connection.close()

            asyncio.run(inspect())

            async def api_responses():
                engine = create_async_engine(make_async_db_url(_database_url(database)))
                try:
                    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                        completion = ModelComplete(request_id=first_request, **artifact)
                        first = await complete_model(db, str(model_id), 1, completion, owner)
                        replay = await complete_model(db, str(model_id), 1, completion, owner)
                        self.assertEqual(first, replay)
                        checked = await check_replica(db, ReplicaRegistration(asset_kind="model", asset_id=model_id,
                            revision=1, storage_id=storage_id, launcher_id=launcher_id, artifact=artifact), owner)
                        self.assertEqual(checked["id"], str(replica_id))
                        self.assertEqual(await db.scalar(select(func.count()).select_from(Replica).where(
                            Replica.model_id == str(model_id), Replica.revision == 1)), 1)
                        lease = await db.get(ModelLease, (str(model_id), 1, str(job_id)))
                        self.assertEqual(lease.replica_id, str(replica_id))
                        deletion = await db.get(Operation, str(deletion_id))
                        self.assertEqual(deletion.details["replica_ids"], [str(deleting_replica_id)])
                        with patch.object(settings, "JWT_SECRET", "prediction-migration-test-secret"):
                            backup = await create_operation(db, OperationCreate(request_id=uuid4(), kind="backup",
                                asset_id=model_id, revision=1, source_replica_id=replica_id,
                                source_launcher_id=launcher_id), owner)
                        self.assertEqual(backup["source_replica_id"], str(replica_id))
                        await stop_operation(db, await db.get(Operation, backup["id"]), cancel=True)
                        return jsonable_encoder({"complete": first, "replay": replay,
                            "models": await list_models(db, owner), "datasets": await list_datasets(db, owner),
                            "storages": await list_storages(db, owner), "operations": await list_operations(db, owner),
                            "backup": backup, "replica": checked,
                            "expected": {"replica": str(replica_id), "serverStorage": str(server_storage_id),
                                "serverReplica": str(server_replica_id), "deletion": str(deletion_id),
                                "deletingReplica": str(deleting_replica_id)}})
                finally:
                    await engine.dispose()

            payload = asyncio.run(api_responses())
            ui_directory = Path(__file__).resolve().parents[2] / "ui"
            node = shutil.which("node")
            self.assertIsNotNone(node, "The migration/API/UI contract test requires Node.js and installed app/ui dependencies.")
            result = subprocess.run([node, "--input-type=module", "--eval", """
                import assert from 'node:assert/strict'
                import { readFileSync } from 'node:fs'
                import { z } from 'zod'
                import { predictionModelSchema, predictionDatasetSchema, predictionStorageSchema,
                    predictionOperationSchema, predictionReplicaSchema } from './src/contracts/api/prediction.ts'
                const data = JSON.parse(readFileSync(0, 'utf8'))
                for (const value of [data.expected.replica, data.expected.serverStorage, data.expected.serverReplica]) {
                    assert.equal(z.uuid().safeParse(value).success, false, 'fixture must exercise legacy version/variant bits')
                }
                const complete = predictionModelSchema.parse(data.complete)
                const replay = predictionModelSchema.parse(data.replay)
                assert.deepEqual(complete, replay)
                assert.equal(complete.revisions.find((item) => item.revision === 1).replicas[0].id, data.expected.replica)
                data.models.items.forEach((item) => predictionModelSchema.parse(item))
                const datasets = data.datasets.items.map((item) => predictionDatasetSchema.parse(item))
                assert.ok(datasets.some((item) => item.revisions.some((revision) =>
                    revision.replicas.some((replica) => replica.id === data.expected.serverReplica))))
                const storages = data.storages.items.map((item) => predictionStorageSchema.parse(item))
                assert.deepEqual(storages.filter((item) => item.kind === 'api_dataset').map((item) => item.storage_id),
                    [data.expected.serverStorage])
                const operations = data.operations.items.map((item) => predictionOperationSchema.parse(item))
                assert.deepEqual(operations.find((item) => item.id === data.expected.deletion).details.replica_ids,
                    [data.expected.deletingReplica])
                assert.equal(predictionOperationSchema.parse(data.backup).source_replica_id, data.expected.replica)
                assert.equal(predictionReplicaSchema.parse(data.replica).id, data.expected.replica)
                console.log('Migrated API responses satisfy the real UI schemas without changing IDs.')
                """], input=json.dumps(payload, ensure_ascii=False), text=True, encoding="utf-8",
                cwd=ui_directory, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        finally:
            asyncio.run(_drop_database(database))
