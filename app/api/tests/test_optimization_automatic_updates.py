"""Automatic rebuilds on disposable PostgreSQL and the real kNN; no Solver calls."""
from copy import deepcopy
from datetime import timedelta
import os
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import delete, func, select

from gpstation.db import Job
from gpstation.service.batches import finish_job, serialize_events
from gpstation.service.state import utcnow
from optimization.automatic_updates import request_automatic_update
from optimization.configuration import ModelUpdatePolicy
from optimization.db import Evaluation, Optimization, Trial
from optimization.model_updates import model_state, reconcile_updates, save_state
from prediction import training
from prediction.db import DatasetRevision, ModelRevision, Operation, TrainingRun
from simulation.db import Measurement, RecordedData
import test_optimization_model_updates as fixtures


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class AutomaticModelUpdateTests(unittest.IsolatedAsyncioTestCase):
    setUpClass = classmethod(fixtures.OptimizationModelUpdateTests.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.OptimizationModelUpdateTests.tearDownClass.__func__)
    asyncSetUp = fixtures.OptimizationModelUpdateTests.asyncSetUp
    asyncTearDown = fixtures.OptimizationModelUpdateTests.asyncTearDown
    selection = fixtures.OptimizationModelUpdateTests.selection
    model_request = fixtures.OptimizationModelUpdateTests.model_request
    reserve = fixtures.OptimizationModelUpdateTests.reserve
    tensor = fixtures.OptimizationModelUpdateTests.tensor
    record = fixtures.OptimizationModelUpdateTests.record
    train_and_publish = fixtures.OptimizationModelUpdateTests.train_and_publish
    optimization = fixtures.OptimizationModelUpdateTests.optimization
    request = fixtures.OptimizationModelUpdateTests.request
    advance = fixtures.OptimizationModelUpdateTests.advance

    async def enable(self, optimization_id, **config):
        async with self.sessions() as db:
            row = await db.get(Optimization, optimization_id)
            row.settings = {**row.settings, "hybrid": {**row.settings["hybrid"],
                "model_update_policy": ModelUpdatePolicy(config=config).model_dump()}}
            await reconcile_updates(db, row)
            await db.commit()

    async def test_real_automatic_rebuild_waits_and_adopts_without_consuming_random_state(self):
        identity = await self.optimization({"id": "random", "config": {"seed": 42, "candidates_per_round": 2}})
        await self.enable(identity, min_new_measurements=1)
        measurement_id = await self.record(3, 90)  # Same Experiment, outside this Optimization.
        async with self.sessions() as db:
            before = deepcopy((await db.get(Optimization, identity)).optimizer_state)
        waiting = await self.advance(identity)
        again = await self.advance(identity)
        self.assertEqual(len(again["updates"]), 1)
        self.assertTrue(again["waiting"])
        item = waiting["updates"][0]
        self.assertEqual(item["origin"], "automatic")
        self.assertEqual(again["automatic"]["attempts"], 1)
        async with self.sessions() as db:
            row = await db.get(Optimization, identity)
            self.assertEqual(row.optimizer_state["algorithm_state"], before["algorithm_state"])
            self.assertEqual(await db.scalar(select(func.count()).select_from(Trial).where(Trial.optimization_id == identity)), 1)
            target = item["target_snapshot"]
            snapshot = await db.get(DatasetRevision, (target["datasetId"], target["revision"]))
            self.assertIn(str(measurement_id), snapshot.summary["sample_fingerprints"])
        await self.train_and_publish(item["operation_id"])
        adopted = await self.advance(identity)
        self.assertEqual(adopted["active_model"]["model_revision"], 2)
        self.assertEqual(adopted["updates"][0]["adopted_round"], 1)
        self.assertEqual(adopted["round_model"], adopted["active_model"])
        self.assertGreaterEqual(adopted["automatic"]["elapsed_seconds"], 0)
        async with self.sessions() as db:
            predictions = (await db.scalars(select(Evaluation).where(Evaluation.optimization_id == identity,
                Evaluation.kind == "prediction"))).all()
            self.assertEqual({item.source["model_revision"] for item in predictions}, {1, 2})

    async def test_only_new_complete_native_measurements_count_not_edits_or_deletions(self):
        identity = await self.optimization()
        await self.enable(identity)
        complete = await self.record(3, 90)
        incomplete = await self.record(4, 100)
        unconfirmed = await self.record(5, 110)
        foreign = await self.record(6, 120)
        async with self.sessions() as db:
            await db.execute(delete(RecordedData).where(RecordedData.measurement_id == incomplete))
            (await db.get(Measurement, unconfirmed)).recorded_at = None
            (await db.get(Measurement, foreign)).user_id = self.other
            original = await db.scalar(select(RecordedData).where(RecordedData.measurement_id == self.measurement_id))
            original.data = self.tensor(999)
            await db.flush()
            row = await db.get(Optimization, identity)
            await reconcile_updates(db, row)
            self.assertEqual(model_state(row)["automatic"]["new_measurements"], 1)
            await db.delete(await db.get(Measurement, complete))
            await db.flush()
            await reconcile_updates(db, row)
            self.assertEqual(model_state(row)["automatic"]["new_measurements"], 0)
            await db.commit()

    async def test_failed_training_consumes_input_once_and_new_results_allow_later_request(self):
        identity = await self.optimization()
        await self.enable(identity, min_new_measurements=1)
        await self.record(3, 90)
        waiting = await self.advance(identity)
        item = waiting["updates"][0]
        async with self.sessions() as db:
            run = await db.get(TrainingRun, item["operation_id"])
            await finish_job(db, await db.get(Job, run.job_id), "failed", "fixture training failure")
            await db.commit()
        continued = await self.advance(identity)
        self.assertEqual(continued["active_model"]["model_revision"], 1)
        self.assertEqual(continued["automatic"]["new_measurements"], 0)
        self.assertEqual(len((await self.advance(identity))["updates"]), 1)
        await self.record(4, 100)
        async with self.sessions() as db:
            await serialize_events(db)
            row = await db.get(Optimization, identity)
            await reconcile_updates(db, row)
            self.assertTrue(await request_automatic_update(db, row, next_round=True, training_busy=False))
            await db.commit()
            self.assertEqual(len(model_state(row)["updates"]), 2)

    async def test_timeout_waits_for_cleanup_and_does_not_cancel_manual_retry(self):
        identity = await self.optimization()
        await self.enable(identity, min_new_measurements=1)
        await self.record(3, 90)
        item = (await self.advance(identity))["updates"][0]
        async with self.sessions() as db:
            row = await db.get(Optimization, identity)
            state = model_state(row)
            attempt = state["updates"][0]["automatic_attempt"]
            attempt.update(started_at=(utcnow() - timedelta(seconds=181)).isoformat(),
                deadline_at=(utcnow() - timedelta(seconds=1)).isoformat())
            save_state(row, state)
            job = await db.get(Job, attempt["job_id"])
            job.launcher_id, job.state = self.launcher_id, "running"
            await db.commit()
        expired = await self.advance(identity)
        self.assertEqual(expired["updates"][0]["state"], "timed_out")
        self.assertTrue(expired["waiting"])
        async with self.sessions() as db:
            run = await db.get(TrainingRun, item["operation_id"])
            job = await db.get(Job, run.job_id)
            self.assertEqual(job.state, "cancelled")
            self.assertIsNotNone(job.cancel_requested_at)
            job.cleaned_at = utcnow()
            await db.commit()
            nonce = str(uuid4())
            await training.preflight(db, item["operation_id"], nonce, self.owner)
            await training.submit(db, item["operation_id"], self.owner, retry_request_id=nonce)
        retried = await self.advance(identity)
        self.assertEqual(retried["updates"][0]["state"], "queued")
        self.assertEqual(retried["automatic"]["elapsed_seconds"], expired["automatic"]["elapsed_seconds"])
        await self.train_and_publish(item["operation_id"])
        self.assertEqual((await self.advance(identity))["active_model"]["model_revision"], 2)

    async def test_admission_conflict_rolls_back_snapshot_and_keeps_search_running(self):
        identity = await self.optimization()
        await self.enable(identity, min_new_measurements=1)
        await self.record(3, 90)
        async with self.sessions() as db:
            count = await db.scalar(select(func.count()).select_from(DatasetRevision))
        with patch("prediction.training.assert_model_update_available", AsyncMock(side_effect=HTTPException(409, "Other model training"))):
            state = await self.advance(identity)
        self.assertEqual(state["updates"], [])
        self.assertEqual(state["automatic"]["reason"], "admission_deferred")
        async with self.sessions() as db:
            row = await db.get(Optimization, identity)
            self.assertEqual(row.state, "running")
            self.assertEqual(row.optimizer_state["round_index"], 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(DatasetRevision)), count)

    async def test_automatic_quality_rejection_keeps_current_model_and_baseline(self):
        identity = await self.optimization()
        await self.enable(identity, min_new_measurements=1)
        await self.record(3, 90)
        item = (await self.advance(identity))["updates"][0]
        await self.train_and_publish(item["operation_id"])
        with patch("optimization.evaluations.require_quality", side_effect=HTTPException(409, "RMSE exceeds limit")):
            state = await self.advance(identity)
        self.assertEqual(state["updates"][0]["state"], "failed")
        self.assertEqual(state["active_model"]["model_revision"], 1)
        self.assertIsNone(state["pending_model"])
        self.assertEqual(state["automatic"]["new_measurements"], 0)

    async def test_partial_reservation_rolls_back_without_pausing_or_consuming_budget(self):
        from prediction.models import reserve_model
        identity = await self.optimization()
        await self.enable(identity, min_new_measurements=1)
        await self.record(3, 90)
        async def partial_reserve(*args, **kwargs):
            await reserve_model(*args, **kwargs)
            raise ValueError("Fixture failure after model reservation")
        with patch("prediction.models.reserve_model", side_effect=partial_reserve):
            state = await self.advance(identity)
        self.assertEqual((state["updates"], state["automatic"]["attempts"]), ([], 0))
        self.assertIn("after model reservation", state["automatic"]["error"]["message"])
        async with self.sessions() as db:
            row = await db.get(Optimization, identity)
            self.assertEqual(row.state, "running")
            self.assertEqual(await db.scalar(select(func.count()).select_from(ModelRevision)
                .where(ModelRevision.model_id == state["active_model"]["model_id"])), 1)

    async def test_paused_and_completed_search_never_request_automatic_training(self):
        for status in ("paused", "completed"):
            with self.subTest(status=status):
                identity = await self.optimization()
                await self.enable(identity, min_new_measurements=1)
                await self.record(3, 90)
                async with self.sessions() as db:
                    row = await db.get(Optimization, identity)
                    row.state = status
                    await db.commit()
                self.assertEqual((await self.advance(identity))["updates"], [])

    async def test_final_round_does_not_rebuild_even_when_new_data_exceeds_threshold(self):
        identity = await self.optimization()
        await self.enable(identity, min_new_measurements=1)
        await self.record(3, 90)
        async with self.sessions() as db:
            row = await db.get(Optimization, identity)
            row.settings = {**row.settings, "max_trials": 1}
            await db.commit()
        self.assertEqual((await self.advance(identity))["updates"], [])
        async with self.sessions() as db:
            self.assertEqual((await db.get(Optimization, identity)).state, "completed")

    async def test_completed_model_after_deadline_remains_saved_but_is_not_adopted(self):
        identity = await self.optimization()
        await self.enable(identity, min_new_measurements=1)
        await self.record(3, 90)
        item = (await self.advance(identity))["updates"][0]
        await self.train_and_publish(item["operation_id"])
        async with self.sessions() as db:
            row = await db.get(Optimization, identity)
            operation = await db.get(Operation, item["operation_id"])
            state = model_state(row)
            state["updates"][0]["automatic_attempt"].update(
                started_at=(operation.completed_at - timedelta(seconds=181)).isoformat(),
                deadline_at=(operation.completed_at - timedelta(seconds=1)).isoformat())
            save_state(row, state)
            await db.commit()
        state = await self.advance(identity)
        self.assertEqual(state["active_model"]["model_revision"], 1)
        self.assertEqual(state["updates"][0]["state"], "timed_out")
        self.assertIsNone(state["pending_model"])
        async with self.sessions() as db:
            revision = await db.get(ModelRevision, (item["model_id"], item["revision"]))
            self.assertEqual(revision.state, "ready")
