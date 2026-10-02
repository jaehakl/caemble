"""Training admission rollback and completed-search projection, without a Solver."""
from datetime import timedelta
import os
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from sqlalchemy import select

from gpstation.db import Job
from gpstation.service.state import utcnow
from optimization import controller
from optimization.db import Optimization, Trial
from optimization.model_updates import finish_updates, model_state, reconcile_updates
from prediction import training
from prediction.db import Operation, TrainingRun
import test_optimization_model_updates as fixtures


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class OptimizationModelUpdateFailureTests(unittest.IsolatedAsyncioTestCase):
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

    async def test_partial_submission_rolls_back_and_failure_does_not_pause_or_retry(self):
        optimization_id = await self.optimization()
        await self.record(3, 90)
        update = await self.request(optimization_id)
        transient_job_id = str(uuid4())
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            run = await db.get(TrainingRun, update["operation_id"])
            original_pin = run.pin_id

            async def partial_submit(current, identity, owner, *, commit):
                self.assertFalse(commit)
                job = Job(id=transient_job_id, user_id=owner, slave_app_id=training.APP_ID,
                    handler_type=training.HANDLER, job_mode="websocket", state="queued", progress=[], resources={},
                    artifact_metadata={"prediction_operation_id": identity}, input={})
                current.add(job)
                await current.flush()
                run.job_id, run.pin_id = job.id, str(uuid4())
                operation = await current.get(Operation, identity)
                operation.state = "queued"
                await current.flush()
                raise ValueError("Fixture admission failed after partial writes")

            with patch("prediction.training.submit", side_effect=partial_submit) as submit:
                self.assertFalse(await reconcile_updates(db, optimization))
                await db.commit()
                self.assertEqual(optimization.state, "running")
                self.assertEqual(model_state(optimization)["active_model"]["model_revision"], 1)
                self.assertEqual(model_state(optimization)["updates"][-1]["state"], "failed")
                self.assertIsNone(run.job_id)
                self.assertEqual(run.pin_id, original_pin)
                self.assertIsNone(await db.get(Job, transient_job_id))
                operation = await db.get(Operation, update["operation_id"])
                self.assertEqual(operation.state, "failed")
                self.assertIn("after partial writes", operation.error["message"])
                self.assertFalse(await reconcile_updates(db, optimization))
                await db.commit()
                self.assertEqual(submit.call_count, 1)

    async def test_completed_controller_projects_active_training_without_restarting_search(self):
        optimization_id = await self.optimization()
        await self.record(3, 90)
        update = await self.request(optimization_id)
        async with self.sessions() as db:
            result = await training.submit(db, update["operation_id"], self.owner)
            operation = await db.get(Operation, update["operation_id"])
            optimization = await db.get(Optimization, optimization_id)
            optimization.state, optimization.finished_at = "completed", utcnow()
            await finish_updates(db, optimization)
            # A running retry remains observable even after its queued state was
            # projected and the Operation timestamp is older than the search.
            operation.updated_at = optimization.updated_at - timedelta(seconds=1)
            job = await db.get(Job, result["training"]["jobId"])
            job.state = "running"
            await db.commit()
            original_round = optimization.optimizer_state["round_index"]
            original_trials = list((await db.scalars(select(Trial.id).where(Trial.optimization_id == optimization_id))).all())

        with patch("optimization.controller.SessionLocal", self.sessions), \
                patch("optimization.predictor_jobs.reconcile_children", new=AsyncMock()), \
                patch("optimization.model_maintenance.reconcile_pruning", new=AsyncMock()), \
                patch.object(controller.job_orchestrator, "wake_dispatcher"):
            await controller.reconcile_once(self.catalog)

        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            state = model_state(optimization)
            self.assertEqual(optimization.state, "completed")
            self.assertEqual(state["updates"][-1]["state"], "running")
            self.assertEqual(state["active_model"]["model_revision"], 1)
            self.assertIsNone(state["pending_model"])
            self.assertEqual(optimization.optimizer_state["round_index"], original_round)
            self.assertEqual(list((await db.scalars(select(Trial.id).where(Trial.optimization_id == optimization_id))).all()), original_trials)
