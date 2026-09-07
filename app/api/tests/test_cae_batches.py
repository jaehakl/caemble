"""Durable CAE lifecycle checks against disposable PostgreSQL databases."""

from __future__ import annotations

import asyncio
import json
import os
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from alembic import command
from alembic.config import Config
from caemble_catalog import Catalog
from fastapi import HTTPException
from sqlalchemy import delete, func, null, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from test_calculation_database import (
    API_DIR, ORIGINAL_DB_URL, _check, _create_database, _database_url, _drop_database,
    _seed_owners, _table_names, _upgrade,
)
from cae.batches import (
    cancel_batch, create_batch, list_batches, require_batch,
    mark_batch_read, require_no_active_batches, retry_batch,
)
from cae.db import CaeBatch
from cae.events import stream_events
from cae.models import BatchCreateRequest
from cae.preparation import PreparationQueue, prepare_input
from cae.recording import complete_job, stage_record
from db import Experiment, ExperimentRecord, Measurement, RecordedData, make_async_db_url
from gpstation.db import Job, JobBatch, JobEvent, JobRecord, Launcher
from gpstation.service.batches import add_event, fail_server_jobs, finish_job, serialize_events
from gpstation.service.job_service import JobService
from gpstation.service.state import utcnow
from gpstation.service.worker_connection import worker_cleaned
from models import RoleEnum, UserData
from service.measurement_service import delete_measurements
from settings import settings


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class CaeBatchDatabaseTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        asyncio.run(_create_database(cls.database))
        try:
            _upgrade(cls.database, "head")
            cls.owner_id, cls.other_id, cls.experiment_id, cls.other_experiment_id = asyncio.run(_seed_owners(cls.database))
            cls.catalog = Catalog.open_readonly()
            entry = next(row for row in cls.catalog.list_experiments(limit=10000)[0] if row["key"] == "electro-thermal-notched-bar")
            cls.example = cls.catalog.experiment(entry["coordinate"])
        except BaseException:
            asyncio.run(_drop_database(cls.database))
            raise

    @classmethod
    def tearDownClass(cls):
        cls.catalog.close()
        asyncio.run(_drop_database(cls.database))

    async def asyncSetUp(self):
        self.engine = create_async_engine(make_async_db_url(_database_url(self.database)))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.owner = UserData(id=self.owner_id, roles=[RoleEnum.user])
        async with self.sessions() as db:
            for model in (Measurement, JobBatch, Job, Launcher, ExperimentRecord):
                await db.execute(delete(model))
            experiment = await db.get(Experiment, self.experiment_id)
            experiment.source_bundle = self.example["sourceBundle"]
            experiment.source_hash = self.example["bundleHash"]
            await db.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def create(self, *, count=1, request_id=None):
        request = BatchCreateRequest(request_id=request_id or uuid.uuid4(), experiment_id=self.experiment_id,
            experiment_source_hash=self.example["bundleHash"], mode="generate", count=count)
        async with self.sessions() as db:
            batch = await create_batch(db, request, self.owner, self.catalog)
            return batch, request

    async def ready_job(self, batch_id, *, index=1, state="queued", attempt=1):
        async with self.sessions() as db:
            batch = await db.get(JobBatch, batch_id)
            job = Job(user_id=self.owner_id, batch_id=batch_id, item_index=index, job_mode="websocket",
                handler_type="cae.simulation", slave_app_id="cae", state=state, attempt_count=attempt,
                input={"measurement": {"experiment": {"simulationProgram": {"recordedData": {
                    "signal": {"dtype": "float64", "tensorOrder": 0, "quantityKind": "DimensionlessRatio"},
                }}}}}, progress=[], offer={})
            db.add(job)
            await db.flush()
            db.add(Measurement(user_id=self.owner_id, experiment_id=self.experiment_id, job_id=job.id,
                vars={"fixed": 7}, material_parameters={"experiment": {"materials": {}}, "tasks": {}}))
            batch.created_count += 1
            await db.commit()
            return job

    async def test_empty_preparation_errors_fail_and_remaining_items_continue(self):
        batch, _ = await self.create(count=2)
        with patch("cae.preparation.SessionLocal", self.sessions):
            queue = PreparationQueue()
            first = await queue._claim()
            with patch("cae.preparation.prepare_input", side_effect=NotImplementedError()):
                await queue._prepare(*first)
            async with self.sessions() as db:
                failed = await db.get(Job, first[0])
                self.assertEqual((failed.state, failed.last_error), ("failed", "NotImplementedError"))
                self.assertEqual((await db.get(JobBatch, batch.id)).failed, 1)
            second = await queue._claim()
            self.assertNotEqual(second[0], first[0])
            with patch("cae.preparation.prepare_input", side_effect=TimeoutError()):
                await queue._prepare(*second)
            async with self.sessions() as db:
                self.assertEqual((await db.get(JobBatch, batch.id)).state, "completed")
                await retry_batch(db, batch.id, self.owner_id, [first[0]])
            retry = await queue._claim()
            self.assertEqual(retry[:2], (first[0], 2))
            await queue._prepare(*retry)
            async with self.sessions() as db:
                self.assertEqual((await db.get(Job, first[0])).state, "queued")

    async def test_idempotency_owner_snapshot_and_browser_independence(self):
        batch, request = await self.create(count=1000000)
        async with self.sessions() as db:
            duplicate = await create_batch(db, request, self.owner, self.catalog)
            self.assertEqual(duplicate.id, batch.id)
            self.assertEqual(await db.scalar(select(func.count()).select_from(Job)), 0)
            frozen = await db.get(CaeBatch, batch.id)
            self.assertEqual(frozen.spec["source_bundle"], self.example["sourceBundle"])
            self.assertTrue(frozen.spec["catalog"]["solvers"])
            self.assertEqual(set(frozen.spec["materials"]), {"names", "materials", "parameters", "qualifiers"})
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as caught:
                await create_batch(db, request.model_copy(update={"count": 2}), self.owner, self.catalog)
            self.assertEqual(caught.exception.status_code, 409)
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as caught:
                await require_batch(db, batch.id, self.other_id)
            self.assertEqual(caught.exception.status_code, 404)
            listing = await list_batches(db, self.other_id, experiment_id=None, limit=50, offset=0)
            self.assertEqual(listing["items"], [])
            self.assertEqual(listing["cursor"], 0)
        async with self.sessions() as db:
            listing = await list_batches(db, self.owner_id, experiment_id=self.experiment_id, limit=50, offset=0)
            self.assertEqual(listing["items"][0]["total"], 1000000)
            self.assertGreater(listing["cursor"], 0)
            with self.assertRaises(HTTPException) as caught:
                await require_no_active_batches(db, [self.experiment_id])
            self.assertEqual(caught.exception.status_code, 409)

    async def test_cancel_counts_unmaterialized_items_once(self):
        batch, _ = await self.create(count=1000000)
        job = await self.ready_job(batch.id, state="preparing")
        async with self.sessions() as db:
            cancelled, assignments = await cancel_batch(db, batch.id, self.owner_id)
            self.assertEqual((cancelled.cancelled, cancelled.created_count), (1000000, 1))
            self.assertEqual(cancelled.state, "cancelled")
            self.assertEqual(assignments, [])
            self.assertEqual((await db.get(Job, job.id)).state, "cancelled")
        async with self.sessions() as db:
            cancelled, _ = await cancel_batch(db, batch.id, self.owner_id)
            self.assertEqual(cancelled.cancelled, 1000000)
            await require_no_active_batches(db, [self.experiment_id])
        with patch("cae.preparation.SessionLocal", self.sessions):
            self.assertIsNone(await PreparationQueue()._claim())

    async def test_concurrent_duplicate_registration_creates_one_batch(self):
        request_id = uuid.uuid4()
        results = await asyncio.gather(self.create(count=3, request_id=request_id), self.create(count=3, request_id=request_id))
        self.assertEqual(results[0][0].id, results[1][0].id)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(JobBatch)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(JobEvent)), 1)

    async def test_retry_after_cancel_does_not_generate_cancelled_items(self):
        batch, _ = await self.create(count=3)
        job = await self.ready_job(batch.id, state="running")
        async with self.sessions() as db:
            await serialize_events(db)
            await finish_job(db, await db.get(Job, job.id), "failed", "worker interrupted")
            await db.commit()
        async with self.sessions() as db:
            cancelled, _ = await cancel_batch(db, batch.id, self.owner_id)
            self.assertEqual((cancelled.failed, cancelled.cancelled, cancelled.created_count), (1, 2, 1))
            self.assertTrue(cancelled.generation_stopped)
        async with self.sessions() as db:
            retried = await retry_batch(db, batch.id, self.owner_id, [job.id])
            self.assertEqual((retried.failed, retried.cancelled, retried.created_count), (0, 2, 1))
            self.assertTrue(retried.generation_stopped)
        with patch("cae.preparation.SessionLocal", self.sessions):
            self.assertIsNone(await PreparationQueue()._claim())
        async with self.sessions() as db:
            current = await db.get(Job, job.id)
            self.assertEqual((current.state, current.attempt_count), ("queued", 2))
            await serialize_events(db)
            await finish_job(db, current, "succeeded")
            await db.commit()
            completed = await db.get(JobBatch, batch.id)
            self.assertEqual((completed.state, completed.succeeded, completed.cancelled), ("completed", 1, 2))
            self.assertEqual(await db.scalar(select(func.count()).select_from(Job)), 1)

    async def test_unprepared_retry_waits_for_existing_prepared_job(self):
        batch, _ = await self.create(count=2)
        ready = await self.ready_job(batch.id)
        retry = await self.ready_job(batch.id, index=2, attempt=2)
        async with self.sessions() as db:
            await db.execute(update(Job).where(Job.id == retry.id).values(input=null()))
            await db.commit()
        with patch("cae.preparation.SessionLocal", self.sessions):
            queue = PreparationQueue()
            self.assertIsNone(await queue._claim())
            async with self.sessions() as db:
                (await db.get(Job, ready.id)).state = "assigned"
                await db.commit()
            claimed = await queue._claim()
            self.assertEqual(claimed[:2], (retry.id, 2))

    async def test_never_prepared_batch_wins_after_previous_item_is_assigned(self):
        first, _ = await self.create(count=1000000)
        second, _ = await self.create(count=1)
        with patch("cae.preparation.SessionLocal", self.sessions):
            queue = PreparationQueue()
            claimed = await queue._claim()
            async with self.sessions() as db:
                job = await db.get(Job, claimed[0])
                self.assertEqual(job.batch_id, first.id)
                job.state = "assigned"
                job.input = {"prepared": True}
                await db.commit()
            claimed_next = await queue._claim()
        async with self.sessions() as db:
            self.assertEqual((await db.get(Job, claimed_next[0])).batch_id, second.id)
            self.assertEqual((await db.get(JobBatch, first.id)).created_count, 1)

    async def test_preparation_round_robin_and_actual_node_input(self):
        first, _ = await self.create(count=2)
        second, _ = await self.create(count=2)
        queue = PreparationQueue()
        with patch("cae.preparation.SessionLocal", self.sessions):
            claimed_first = await queue._claim()
            claimed_second = await queue._claim()
            self.assertIsNone(await queue._claim())
        self.assertIsNotNone(claimed_first)
        self.assertIsNotNone(claimed_second)
        async with self.sessions() as db:
            first_job = await db.get(Job, claimed_first[0])
            second_job = await db.get(Job, claimed_second[0])
            self.assertEqual((first_job.batch_id, second_job.batch_id), (first.id, second.id))
            self.assertEqual((first_job.attempt_count, second_job.attempt_count), (1, 1))
        prepared = await prepare_input(claimed_first[2])
        self.assertEqual(prepared["measurement"]["kind"], "measurement")
        self.assertEqual(prepared["measurement"]["experiment"]["sourceHash"], self.example["bundleHash"])
        self.assertNotIn("renderScene", prepared["measurement"]["experiment"])
        self.assertEqual(prepared["material_parameters"]["tasks"]["electric"], prepared["material_parameters"]["tasks"]["thermal"])
        with patch("cae.preparation.SessionLocal", self.sessions), patch("cae.preparation.prepare_input", return_value=prepared):
            await queue._prepare(*claimed_first)
        async with self.sessions() as db:
            job = await db.get(Job, claimed_first[0])
            self.assertEqual(job.state, "queued")
            self.assertEqual(job.input["measurement"], prepared["measurement"])
            measurement = await db.scalar(select(Measurement).where(Measurement.job_id == job.id))
            self.assertEqual(measurement.vars, prepared["vars"])
            self.assertIsNone(measurement.recorded_at)

    async def test_concurrent_claims_obey_owner_capability_and_one_slot(self):
        batch, _ = await self.create(count=3)
        jobs = [await self.ready_job(batch.id, index=index) for index in range(1, 4)]
        now = utcnow()
        async with self.sessions() as db:
            launchers = [Launcher(user_id=owner, launcher_name=name, status="ready", slave_app_ids=["cae"],
                job_modes=modes, connected_at=now, last_heartbeat_at=now) for owner, name, modes in (
                (self.owner_id, "first", {"cae": "websocket"}),
                (self.owner_id, "second", {"cae": "websocket"}),
                (self.owner_id, "legacy", {}),
                (self.other_id, "other", {"cae": "websocket"}),
            )]
            db.add_all(launchers)
            await db.commit()
            ids = {launcher.id for launcher in launchers}
        async def claim():
            async with self.sessions() as db:
                return await JobService.claim_next_compatible_job(db, idle_launcher_ids=ids)
        assignments = await asyncio.gather(claim(), claim(), claim())
        assigned = [item for item in assignments if item]
        self.assertEqual(len(assigned), 2)
        self.assertEqual({item[1] for item in assigned}, {launchers[0].id, launchers[1].id})
        self.assertEqual(len({item[0].id for item in assigned}), 2)
        self.assertTrue(all(item[0].attempt_count == 1 for item in assigned))
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Job).where(Job.state == "queued")), 1)
            self.assertEqual(len(jobs), 3)

    async def test_restart_and_manual_retry_reuse_frozen_input(self):
        batch, _ = await self.create(count=2)
        running = await self.ready_job(batch.id, state="running")
        queued = await self.ready_job(batch.id, index=2)
        async with self.sessions() as db:
            failed = await fail_server_jobs(db, detail="server restarted", restarting=True)
            self.assertEqual([job.id for job in failed], [running.id])
        async with self.sessions() as db:
            self.assertEqual((await db.get(Job, queued.id)).state, "queued")
            self.assertEqual((await db.get(JobBatch, batch.id)).failed, 1)
            old_input = (await db.get(Job, running.id)).input
            retried = await retry_batch(db, batch.id, self.owner_id, [running.id])
            self.assertEqual(retried.failed, 0)
            job = await db.get(Job, running.id)
            self.assertEqual((job.state, job.attempt_count, job.input), ("queued", 2, old_input))
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as caught:
                await retry_batch(db, batch.id, self.owner_id, [queued.id])
            self.assertEqual(caught.exception.status_code, 409)

    async def test_staging_publish_atomicity_and_terminal_idempotence(self):
        batch, _ = await self.create()
        job = await self.ready_job(batch.id, state="running", attempt=2)
        async with self.sessions() as db:
            db.add(ExperimentRecord(experiment_id=self.experiment_id, name="signal", dtype="float64",
                tensor_order=0, quantity_kind="DimensionlessRatio", contract_hash="signal", data_schema={}))
            # A stale attempt's staging must not be included in this attempt.
            db.add(JobRecord(job_id=job.id, attempt_count=1, sequence=1, name="signal", payload={"stale": True}))
            await db.commit()
        packet = {"sequence": 1, "name": "signal", "value": {"shape": [], "storage": {"kind": "inline", "value": 7.5}}}
        async with self.sessions() as db:
            current = await db.get(Job, job.id)
            await stage_record(db, current, packet, [])
            await db.commit()
            await stage_record(db, current, packet, [])
            await db.commit()
            self.assertEqual(await db.scalar(select(func.count()).select_from(JobRecord).where(JobRecord.attempt_count == 2)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(RecordedData)), 0)
            measurement = await db.scalar(select(Measurement).where(Measurement.job_id == job.id))
            self.assertIsNone(measurement.recorded_at)
        async with self.sessions() as db:
            current = await db.get(Job, job.id)
            with self.assertRaises(ValueError):
                await stage_record(db, current, {**packet, "sequence": 3}, [])
            await db.rollback()
        async with self.sessions() as db:
            current = await db.get(Job, job.id)
            await complete_job(db, current, {"recordSequences": [1]})
            await db.rollback()
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(RecordedData)), 0)
            current = await db.get(Job, job.id)
            await serialize_events(db)
            result = await complete_job(db, current, {"recordSequences": [1]})
            self.assertTrue(await finish_job(db, current, "succeeded", result=result))
            await db.commit()
            self.assertFalse(await finish_job(db, current, "succeeded", result=result))
            await db.commit()
        async with self.sessions() as db:
            records = list((await db.scalars(select(RecordedData))).all())
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0].data, packet["value"])
            finished = await db.get(JobBatch, batch.id)
            self.assertEqual((finished.state, finished.succeeded), ("completed", 1))
            self.assertEqual(await db.scalar(select(func.count()).select_from(JobEvent).where(JobEvent.type == "job.succeeded")), 1)
            with self.assertRaises(ValueError):
                await complete_job(db, await db.get(Job, job.id), {"recordSequences": [1]})

    async def test_stale_cleanup_cannot_release_a_new_attempt(self):
        batch, _ = await self.create()
        job = await self.ready_job(batch.id, state="running", attempt=2)
        now = utcnow()
        async with self.sessions() as db:
            launcher = Launcher(user_id=self.owner_id, launcher_name="busy", status="busy", slave_app_ids=["cae"],
                job_modes={"cae": "websocket"}, connected_at=now, last_heartbeat_at=now)
            db.add(launcher)
            await db.flush()
            (await db.get(Job, job.id)).launcher_id = launcher.id
            launcher_id = launcher.id
            await db.commit()
            self.assertFalse(await worker_cleaned(db, job_id=job.id, attempt_count=1, launcher_id=launcher.id, user_id=self.owner_id))
            await db.rollback()
        async with self.sessions() as db:
            self.assertEqual((await db.get(Launcher, launcher_id)).status, "busy")
            self.assertEqual((await db.get(Job, job.id)).state, "running")

    async def test_sse_owner_replay_snapshot_cursor_and_persisted_read_state(self):
        batch, _ = await self.create()
        async with self.sessions() as db:
            snapshot = await list_batches(db, self.owner_id, experiment_id=None, limit=50, offset=0)
            cursor = snapshot["cursor"]
        async with self.sessions() as db:
            other = await create_batch(db, BatchCreateRequest(request_id=uuid.uuid4(),
                experiment_id=self.other_experiment_id, experiment_source_hash="hash-calc-other", mode="generate"),
                UserData(id=self.other_id, roles=[RoleEnum.user]), self.catalog)
            other_event = other.last_event_id
        async with self.sessions() as db:
            await serialize_events(db)
            current = await db.get(JobBatch, batch.id)
            progress = await add_event(db, current, "job.progress", payload={"message": "계산 진행 중"})
            finished = await add_event(db, current, "job.succeeded", payload={"measurement_id": 37})
            await db.commit()
            progress_id, finished_id = progress.id, finished.id
        request = SimpleNamespace(headers={}, is_disconnected=AsyncMock(return_value=False))
        with patch("cae.events.SessionLocal", self.sessions):
            stream = stream_events(request, self.owner_id, cursor)
            try:
                frames = [await asyncio.wait_for(anext(stream), 2), await asyncio.wait_for(anext(stream), 2)]
            finally:
                await stream.aclose()
            events = [json.loads(frame.split("data: ", 1)[1]) for frame in frames]
            self.assertEqual([event["id"] for event in events], [progress_id, finished_id])
            self.assertTrue(all(event["batch_id"] == batch.id for event in events))
            self.assertEqual(events[0]["payload"]["message"], "계산 진행 중")
            self.assertEqual(events[1]["measurement_id"], 37)
            self.assertTrue(frames[0].startswith(f"id: {progress_id}\n"))

            resumed = stream_events(SimpleNamespace(headers={"last-event-id": str(progress_id)},
                is_disconnected=AsyncMock(return_value=False)), self.owner_id, cursor)
            try:
                event = json.loads((await asyncio.wait_for(anext(resumed), 2)).split("data: ", 1)[1])
                self.assertEqual(event["id"], finished_id)
            finally:
                await resumed.aclose()
            others = stream_events(request, self.other_id, 0)
            try:
                event = json.loads((await asyncio.wait_for(anext(others), 2)).split("data: ", 1)[1])
                self.assertEqual((event["id"], event["batch_id"]), (other_event, other.id))
            finally:
                await others.aclose()

        async def mark(event_id):
            async with self.sessions() as db:
                await mark_batch_read(db, batch.id, self.owner_id, event_id)
        await asyncio.gather(mark(finished_id), mark(progress_id), mark(cursor))
        async with self.sessions() as db:
            restored = await require_batch(db, batch.id, self.owner_id)
            self.assertEqual(restored.read_event_id, finished_id)
            await mark_batch_read(db, batch.id, self.owner_id, finished_id + 1000)
        async with self.sessions() as db:
            self.assertEqual((await db.get(JobBatch, batch.id)).read_event_id, finished_id)
            with self.assertRaises(HTTPException) as caught:
                await mark_batch_read(db, batch.id, self.other_id, finished_id)
            self.assertEqual(caught.exception.status_code, 404)

    async def test_retry_and_measurement_delete_cannot_both_succeed(self):
        batch, _ = await self.create()
        job = await self.ready_job(batch.id, state="running")
        async with self.sessions() as db:
            await serialize_events(db)
            await finish_job(db, await db.get(Job, job.id), "failed", "interrupted")
            await db.commit()
            measurement_id = await db.scalar(select(Measurement.id).where(Measurement.job_id == job.id))
        async def retry():
            async with self.sessions() as db:
                try:
                    await retry_batch(db, batch.id, self.owner_id, [job.id])
                    return "retried"
                except HTTPException as error:
                    return error.status_code
        async def remove():
            async with self.sessions() as db:
                try:
                    await delete_measurements(db, [measurement_id], user=self.owner)
                    return "deleted"
                except HTTPException as error:
                    return error.status_code
        outcome = await asyncio.wait_for(asyncio.gather(retry(), remove()), 5)
        self.assertIn(outcome, (["retried", 409], [409, "deleted"]))
        async with self.sessions() as db:
            current = await db.get(Job, job.id)
            measurement = await db.get(Measurement, measurement_id)
            if outcome[0] == "retried":
                self.assertEqual((current.state, current.attempt_count), ("queued", 2))
                self.assertIsNotNone(measurement)
            else:
                self.assertEqual((current.state, current.attempt_count), ("failed", 1))
                self.assertIsNone(measurement)

    def test_additive_migration_preserves_existing_rows(self):
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        try:
            asyncio.run(_create_database(database))
            _upgrade(database, "head")
            owner_id, _, experiment_id, _ = asyncio.run(_seed_owners(database))
            async def seed_existing():
                engine = create_async_engine(make_async_db_url(_database_url(database)))
                try:
                    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                        job = Job(user_id=owner_id, handler_type="ai.chat", slave_app_id="ai", state="succeeded", offer={"sdp": "retained"})
                        measurement = Measurement(user_id=owner_id, experiment_id=experiment_id, vars={"retained": 1},
                            material_parameters={"retained": True}, recorded_at=utcnow())
                        record = ExperimentRecord(experiment_id=experiment_id, name="signal", dtype="float64",
                            tensor_order=0, contract_hash="retained", data_schema={})
                        db.add_all([job, measurement, record])
                        await db.flush()
                        db.add(RecordedData(user_id=owner_id, measurement_id=measurement.id, experiment_record_id=record.id,
                            data={"shape": [], "storage": {"kind": "inline", "value": 42}}))
                        await db.commit()
                        return job.id, measurement.id
                finally:
                    await engine.dispose()
            job_id, measurement_id = asyncio.run(seed_existing())
            settings.db_url = _database_url(database)
            try:
                command.downgrade(Config(str(API_DIR / "alembic.ini")), "000000000005")
            finally:
                settings.db_url = ORIGINAL_DB_URL
            self.assertNotIn("job_batches", asyncio.run(_table_names(database)))
            _upgrade(database, "head")
            _check(database)
            self.assertTrue({"job_batches", "cae_batches", "job_events", "job_records"}.issubset(asyncio.run(_table_names(database))))
            async def verify():
                engine = create_async_engine(make_async_db_url(_database_url(database)))
                try:
                    async with async_sessionmaker(engine)() as db:
                        self.assertEqual(await db.scalar(select(func.count()).select_from(Experiment)), 2)
                        job = await db.get(Job, job_id)
                        self.assertEqual((job.job_mode, job.offer, job.state), ("webrtc", {"sdp": "retained"}, "succeeded"))
                        measurement = await db.get(Measurement, measurement_id)
                        self.assertEqual(measurement.vars, {"retained": 1})
                        self.assertIsNotNone(measurement.recorded_at)
                        record = await db.scalar(select(RecordedData).where(RecordedData.measurement_id == measurement_id))
                        self.assertEqual(record.data["storage"]["value"], 42)
                finally:
                    await engine.dispose()
            asyncio.run(verify())
        finally:
            settings.db_url = ORIGINAL_DB_URL
            asyncio.run(_drop_database(database))


if __name__ == "__main__":
    unittest.main()
