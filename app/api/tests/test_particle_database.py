"""Opt-in PostgreSQL requery of saved results from the three actual particle solvers.

Set RUN_PARTICLE_DB_TESTS=1, PARTICLE_TEST_DB_URL to a disposable loopback
PostgreSQL server with pgvector, and PARTICLE_DEM_RESULT/PARTICLE_SPH_RESULT/
PARTICLE_MPM_RESULT to successful local result directories containing manifest.json.
No solver execution or remote database connection occurs in this test.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from sqlalchemy import func, select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

import test_calculation_database as database_helpers
from cae.db import CaeBatch
from cae.preflight import preflight_result
from cae.recording import complete_job, persist_record, stage_record, stage_visualization
from db import Experiment, ExperimentRecord, Measurement, RecordedData, make_async_db_url
from gpstation.db import Job, JobBatch, JobRecord, JobVisualization
from gpstation.service.batches import finish_job
from models import RoleEnum, UserData
from service.measurement_service import get_recorded_data, get_visualizations
from settings import settings


@unittest.skipUnless(os.getenv("RUN_PARTICLE_DB_TESTS") == "1", "Set RUN_PARTICLE_DB_TESTS=1 for local PostgreSQL integration.")
class ParticleDatabaseTests(unittest.TestCase):
    def test_dem_measurement_and_preflight_requery(self):
        self._verify_saved_result("dem")

    def test_sph_measurement_and_preflight_requery(self):
        self._verify_saved_result("sph")

    def test_mpm_measurement_and_preflight_requery(self):
        self._verify_saved_result("mpm")

    def _verify_saved_result(self, solver):
        url = os.environ["PARTICLE_TEST_DB_URL"]
        if make_url(url).host not in {"127.0.0.1", "::1", "localhost"}:
            raise RuntimeError("Particle integration tests require an explicitly selected loopback database.")
        directory = Path(os.environ[f"PARTICLE_{solver.upper()}_RESULT"]).resolve()
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["state"], "succeeded")
        input_bytes = Path(manifest["input"]).read_bytes()
        self.assertEqual(hashlib.sha256(input_bytes).hexdigest(), manifest["inputHash"])
        measurement_input = json.loads(input_bytes)["measurement"]
        self.assertEqual({task["kernel"]["name"] for task in measurement_input["experiment"]["simulationProgram"]["tasks"].values()}, {solver})
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        with patch.object(database_helpers, "ORIGINAL_DB_URL", url), patch.object(settings, "db_url", url):
            asyncio.run(database_helpers._create_database(database))
            try:
                database_helpers._upgrade(database, "head")
                asyncio.run(self._verify_database(database, directory, manifest, measurement_input))
            finally:
                asyncio.run(database_helpers._drop_database(database))

    async def _verify_database(self, database, directory, manifest, measurement_input):
        owner, _, experiment_id, _ = await database_helpers._seed_owners(database)
        user = UserData(id=owner, roles=[RoleEnum.user])
        engine = create_async_engine(make_async_db_url(database_helpers._database_url(database)))
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        program = measurement_input["experiment"]["simulationProgram"]
        schemas = program["recordedData"]
        expected_records, expected_visuals, packets = {}, {}, []
        for item in [*manifest["records"], *manifest["visualizations"]]:
            packet = json.loads((directory / item["path"]).read_text(encoding="utf-8"))
            attachments = [SimpleNamespace(id=part["id"], data=(directory / part["path"]).read_bytes()) for part in item["attachments"]]
            blobs = {part.id: part.data for part in attachments}
            packets.append((packet, attachments))
            if "name" in packet:
                expected_records[packet["name"]] = persist_record(schemas[packet["name"]], packet["value"], blobs)
            else:
                expected_visuals[packet["task"]] = {
                    name: {**entry, "data": persist_record(entry["schema"], entry["data"], blobs)}
                    for name, entry in packet["visualizations"].items()
                }
                for name, entry in packet["visualizations"].items():
                    for key, tensor in entry["data"].items():
                        if tensor["storage"]["kind"] == "attachments":
                            stored = expected_visuals[packet["task"]][name]["data"][key]["storage"]
                            self.assertEqual(base64.b64decode(stored["data"]), b"".join(blobs[id] for id in tensor["storage"]["ids"]))
        self.assertEqual(len(expected_records), 3)
        self.assertTrue(expected_visuals)
        packets.sort(key=lambda item: item[0]["sequence"])
        try:
            async with sessions() as session:
                experiment = await session.get(Experiment, experiment_id)
                experiment.result_contracts = program["resultContracts"]
                for name, schema in schemas.items():
                    session.add(ExperimentRecord(experiment_id=experiment_id, name=name,
                        quantity_kind=schema.get("quantityKind"), tensor_order=schema.get("tensorOrder", 0),
                        dtype=schema["dtype"], data_schema=schema,
                        contract_hash=hashlib.sha256(json.dumps(schema, sort_keys=True).encode()).hexdigest()))
                await session.commit()
            for preflight in (False, True):
                with self.subTest(preflight=preflight):
                    async with sessions() as session:
                        batch = JobBatch(user_id=owner, request_id=str(uuid.uuid4()), request_hash=manifest["inputHash"],
                            total=1, created_count=1, succeeded=0, failed=0, cancelled=0, state="running")
                        session.add(batch)
                        await session.flush()
                        session.add(CaeBatch(batch_id=batch.id, experiment_id=None if preflight else experiment_id, spec={
                            "preflight": preflight, "catalog_revision": manifest["catalogRevision"],
                            "source_hash": manifest["sourceHash"], "source_bundle": {"files": {}},
                        }))
                        job = Job(user_id=owner, batch_id=batch.id, item_index=1, handler_type="cae.simulation",
                            slave_app_id="cae", job_mode="websocket", state="running", attempt_count=1,
                            input={"preflight": preflight, "measurement": measurement_input})
                        session.add(job)
                        await session.flush()
                        measurement = None
                        if not preflight:
                            measurement = Measurement(user_id=owner, experiment_id=experiment_id, job_id=job.id,
                                vars=measurement_input.get("vars", {}), material_snapshot=measurement_input.get("materialSnapshot", {}))
                            session.add(measurement)
                            await session.flush()
                        job_id, batch_id = job.id, batch.id
                        measurement_id = measurement.id if measurement is not None else None
                        await session.commit()
                    async with sessions() as session:
                        job = await session.get(Job, job_id)
                        for packet, attachments in packets:
                            if "name" in packet:
                                await stage_record(session, job, packet, attachments)
                            else:
                                await stage_visualization(session, job, packet, attachments)
                            await session.flush()
                        await session.commit()
                    async with sessions() as session:
                        staged = (await session.scalars(select(JobVisualization).where(JobVisualization.job_id == job_id))).all()
                        self.assertEqual({row.task: row.payload for row in staged}, expected_visuals)
                        job = await session.get(Job, job_id)
                        completed = await complete_job(session, job, {
                            "recordSequences": manifest["recordSequences"], "visualizationSequences": manifest["visualizationSequences"],
                            "executionTrace": manifest["trace"],
                        })
                        self.assertTrue(await finish_job(session, job, "succeeded", result=completed))
                        await session.commit()
                    async with sessions() as session:
                        self.assertEqual(await session.scalar(select(func.count()).select_from(JobRecord).where(JobRecord.job_id == job_id)), 0)
                        self.assertEqual(await session.scalar(select(func.count()).select_from(JobVisualization).where(JobVisualization.job_id == job_id)), 0)
                        if preflight:
                            fetched = await preflight_result(session, batch_id, owner)
                            self.assertEqual(fetched["visualizations"], expected_visuals)
                            self.assertEqual(fetched["recorded_data"], expected_records)
                            self.assertEqual(fetched["execution_trace"], manifest["trace"])
                            self.assertEqual(fetched["schemas"], schemas)
                            self.assertEqual(await session.scalar(select(func.count()).select_from(Measurement).where(Measurement.job_id == job_id)), 0)
                        else:
                            fetched = await get_visualizations(session, measurement_id, user=user)
                            self.assertEqual(fetched.visualizations, expected_visuals)
                            recorded = await get_recorded_data(session, measurement_id, user=user)
                            self.assertEqual({name: leaf.data for name, leaf in recorded.recorded_data.items()}, expected_records)
                            self.assertEqual(recorded.result_contracts, program["resultContracts"])
                            self.assertEqual({name: leaf.data_schema for name, leaf in recorded.recorded_data.items()}, schemas)
                            self.assertIsNotNone((await session.get(Measurement, measurement_id)).recorded_at)
                            self.assertEqual(await session.scalar(select(func.count()).select_from(RecordedData).where(RecordedData.measurement_id == measurement_id)), 3)
        finally:
            await engine.dispose()


if __name__ == "__main__":
    unittest.main()
