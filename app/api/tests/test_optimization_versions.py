"""Execution-version admission without a database or numerical workers."""
from copy import deepcopy
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from fastapi import HTTPException

from optimization import controller, guards, model_updates, service
from optimization.search import continuation_assessment, initialize_search
from prediction import training
from prediction.db import TrainingRun


class OptimizationVersionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.settings = {"initial_vars": {"x": 1},
            "axes": [{"name": "x", "indices": [], "min": 0, "max": 10, "fixed": False}],
            "objective": {"direction": "minimize"}, "constraints": [], "max_trials": 5, "max_parallel": 2}
        self.optimization = SimpleNamespace(id=str(uuid4()), user_id="owner", state="paused",
            settings=self.settings, optimizer_state=initialize_search(self.settings), definition={})

    def test_complete_new_state_and_unsupported_saved_states(self):
        self.assertEqual(continuation_assessment(self.settings, self.optimization.optimizer_state),
            {"supported": True, "reason": None})
        damaged = deepcopy(self.optimization.optimizer_state)
        damaged["algorithm_state"]["data"] = {}
        states = [{}, {"search_version": 1}, {"search_version": 99},
            {"search_version": 2}, damaged, {**self.optimization.optimizer_state, "round_index": -1}]
        for state in states:
            with self.subTest(state=state):
                original = deepcopy(state)
                assessment = continuation_assessment(self.settings, state)
                self.assertFalse(assessment["supported"])
                self.assertIn("Create a new Optimization", assessment["reason"])
                self.assertEqual(state, original)

    async def test_compatibility_precedes_hybrid_reconciliation_and_training(self):
        self.settings["hybrid"] = {"max_solver_runs": 3}
        damaged = deepcopy(self.optimization.optimizer_state)
        damaged["algorithm_state"]["data"] = {}
        for state in ({}, {"search_version": 1}, {"search_version": 99}, damaged):
            with self.subTest(state=state):
                self.optimization.optimizer_state = state
                self.optimization.state = "running"
                with patch("optimization.controller.reconcile_incompatible", AsyncMock()) as drain, \
                        patch("optimization.hybrid.reconcile_hybrid", AsyncMock()) as hybrid, \
                        patch("optimization.model_updates.reconcile_updates", AsyncMock()) as updates:
                    await controller.reconcile_optimization(object(), self.optimization, object())
                drain.assert_awaited_once()
                hybrid.assert_not_awaited()
                updates.assert_not_awaited()

    async def test_legacy_trial_receipt_replays_but_new_retry_and_resume_are_rejected(self):
        self.optimization.optimizer_state = {"search_version": 1}
        request_id = str(uuid4())
        trial = SimpleNamespace(retry_request_id=request_id, retry_requests=[request_id], state="failed")
        db = SimpleNamespace(scalar=AsyncMock(), commit=AsyncMock())
        with patch("optimization.controller.ensure_evaluation", AsyncMock()) as ensure:
            await controller.request_retry(db, self.optimization, trial, request_id)
            with self.assertRaises(HTTPException) as rejected:
                await controller.request_retry(db, self.optimization, trial, str(uuid4()))
            self.assertEqual(rejected.exception.status_code, 409)
            self.assertEqual(rejected.exception.detail["code"], "optimization_version_unsupported")
            with self.assertRaises(HTTPException) as rejected:
                await service.resume_optimization(db, self.optimization)
            self.assertEqual(rejected.exception.status_code, 409)
        ensure.assert_not_awaited()
        db.scalar.assert_not_awaited()
        self.assertEqual(trial.retry_requests, [request_id])
        self.assertEqual(trial.state, "failed")

    async def test_legacy_evaluation_receipt_replays_but_new_request_creates_no_jobs(self):
        self.optimization.optimizer_state = {}
        request_id = str(uuid4())
        evaluation = SimpleNamespace(id=str(uuid4()), retry_requests=[request_id], state="failed")
        db = SimpleNamespace(scalar=AsyncMock(return_value=evaluation), commit=AsyncMock())
        receipt = {"id": self.optimization.id, "continuation": {"supported": False, "reason": "old"}}
        with patch("optimization.service.serialize_events", AsyncMock()), \
                patch("optimization.service.require_optimization", AsyncMock(return_value=self.optimization)), \
                patch("optimization.service.optimization_detail", AsyncMock(return_value=receipt)), \
                patch("optimization.submissions.submit_stage", AsyncMock()) as submit:
            self.assertEqual(await service.retry_evaluation(db, self.optimization.id, evaluation.id,
                request_id, None, None), receipt)
            with self.assertRaises(HTTPException) as rejected:
                await service.retry_evaluation(db, self.optimization.id, evaluation.id, str(uuid4()), None, None)
        self.assertEqual(rejected.exception.status_code, 409)
        self.assertEqual(evaluation.retry_requests, [request_id])
        db.commit.assert_awaited_once()
        submit.assert_not_awaited()

    async def test_legacy_model_update_receipt_replays_before_new_training_admission(self):
        request_id = str(uuid4())
        source = {"model_id": str(uuid4()), "model_revision": 1}
        update = {"request_id": request_id, "request_ids": [], "update_mode": "rebuild"}
        self.optimization.definition = {"hybrid": source}
        self.optimization.optimizer_state = {"search_version": 1, "model_update": {
            "initial_model": source, "active_model": source, "round_model": source,
            "pending_model": None, "updates": [update], "waiting": False}}
        db = SimpleNamespace(scalar=AsyncMock(), get=AsyncMock())
        with patch("prediction.training.submit", AsyncMock()) as submit:
            self.assertFalse(await model_updates.request_update(db, self.optimization,
                SimpleNamespace(request_id=request_id, update_mode="rebuild")))
            with self.assertRaises(HTTPException) as rejected:
                await model_updates.request_update(db, self.optimization,
                    SimpleNamespace(request_id=str(uuid4()), update_mode="rebuild"))
        self.assertEqual(rejected.exception.status_code, 409)
        self.assertEqual(self.optimization.optimizer_state["model_update"]["updates"], [update])
        db.scalar.assert_not_awaited()
        db.get.assert_not_awaited()
        submit.assert_not_awaited()

    async def test_linked_training_checks_originating_execution_version(self):
        db = SimpleNamespace(get=AsyncMock(return_value=self.optimization))
        origin = {"optimization_id": self.optimization.id}
        await guards.require_training_continuation(db, origin)
        self.optimization.optimizer_state = {"search_version": 1}
        with self.assertRaises(HTTPException) as rejected:
            await guards.require_training_continuation(db, origin)
        self.assertEqual(rejected.exception.status_code, 409)
        db.get.return_value = None
        with self.assertRaises(HTTPException) as missing:
            await guards.require_training_continuation(db, origin)
        self.assertEqual(missing.exception.status_code, 409)
        await guards.require_training_continuation(db, None)

    async def test_linked_training_routes_replay_receipts_but_reject_new_preflight_and_submission(self):
        self.optimization.optimizer_state = {"search_version": 1}
        request_id = str(uuid4())
        operation = SimpleNamespace(id=str(uuid4()), details={"online_origin": {
            "optimization_id": self.optimization.id}})
        run = SimpleNamespace(retry_requests=[request_id], preflight_request_id=request_id, job_id="existing-job")
        db = SimpleNamespace(get=AsyncMock(side_effect=lambda model, _: run if model is TrainingRun else self.optimization))
        receipt = {"id": operation.id, "state": "failed"}
        with patch("prediction.training.serialize_events", AsyncMock()), \
                patch("prediction.operations.owned_operation", AsyncMock(return_value=operation)), \
                patch("prediction.training.operation_view", AsyncMock(return_value=receipt)), \
                patch("prediction.training.connected_storage", AsyncMock()) as storage:
            self.assertEqual(await training.preflight(db, operation.id, request_id, "owner"), receipt)
            self.assertEqual(await training.submit(db, operation.id, "owner", retry_request_id=request_id), receipt)
            self.assertEqual(await training.submit(db, operation.id, "owner"), receipt)
            with self.assertRaises(HTTPException) as preflight:
                await training.preflight(db, operation.id, str(uuid4()), "owner")
            with self.assertRaises(HTTPException) as submit:
                await training.submit(db, operation.id, "owner", retry_request_id=str(uuid4()))
        self.assertEqual(preflight.exception.status_code, 409)
        self.assertEqual(submit.exception.status_code, 409)
        self.assertEqual(run.retry_requests, [request_id])
        storage.assert_not_awaited()
