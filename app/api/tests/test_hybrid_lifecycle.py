"""Hybrid Job transitions with fake persistence; no DB, transport or numerical workers."""
from copy import deepcopy
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

from fastapi import HTTPException

from optimization import controller, service, submissions
from optimization.model_updates import round_source


class HybridLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.source = {"model_id": str(uuid4()), "model_revision": 3, "checksum": "a" * 64,
            "dataset_id": str(uuid4()), "dataset_revision": 2, "dataset_fingerprint": "dataset-fingerprint",
            "launcher_id": str(uuid4()), "model_definition": {"algorithm": {"kind": "mlp"}},
            "source_contracts": {"records": [{"name": "temperature"}]}, "resources": {
                "evaluation": {"cpu_cores": 1, "gpu_count": 0}, "predictor": {"cpu_cores": 1, "gpu_count": 0}}}
        self.optimization = SimpleNamespace(id=str(uuid4()), user_id="owner", state="running",
            definition={"hash": "definition", "source_hash": "source", "source_bundle": {},
                "catalog": {}, "hybrid": deepcopy(self.source)}, optimizer_state={},
            settings={"objective": {"direction": "minimize"}}, best_trial_id=None, finished_at=None)
        self.trials = [SimpleNamespace(id=str(uuid4()), ordinal=index + 1, variables={"x": index},
            state="pending", next_stage="build") for index in range(2)]
        self.evaluations = [SimpleNamespace(id=str(uuid4()), trial_id=trial.id, kind="prediction",
            source=deepcopy(self.source), state="running", next_stage="predict", error=None,
            manual_retry_requested=False, retry_request_id=None, retry_requests=[],
            result={"objective": -1000., "feasible": True}) for trial in self.trials]
        self.submission = SimpleNamespace(id=str(uuid4()), trial_id=self.trials[0].id,
            state="running", stage="predict", result=None, error=None)
        self.job = SimpleNamespace(id=str(uuid4()), state="succeeded", last_error="fixture failure",
            artifact_metadata={"optimization_id": self.optimization.id})
        trials = {trial.id: trial for trial in self.trials}
        self.db = SimpleNamespace(scalar=AsyncMock(side_effect=lambda *_: self.optimization),
            get=AsyncMock(side_effect=lambda _, identity: trials[identity]),
            scalars=AsyncMock(return_value=SimpleNamespace(all=lambda: [])), add=Mock(),
            flush=AsyncMock(), commit=AsyncMock())

    async def test_terminal_batch_replay_does_not_repeat_transitions_or_create_solver_work(self):
        for outcome in ("succeeded", "failed", "cancelled", "resource-wait"):
            with self.subTest(outcome=outcome):
                self.setUp()
                self.job.state = "failed" if outcome == "resource-wait" else outcome
                if outcome == "resource-wait":
                    self.job.artifact_metadata["optimization_resource_wait"] = True
                elif outcome == "cancelled":
                    self.job.artifact_metadata["optimization_cancel_reason"] = "user"
                self.db.scalar.side_effect = [self.optimization, self.submission] * 2
                identities = [(item.id, item.trial_id, deepcopy(item.source)) for item in self.evaluations]
                with patch("optimization.controller.submission_evaluations", AsyncMock(return_value=self.evaluations)) as linked, \
                        patch("optimization.controller.solver_budget", AsyncMock(return_value={"limit": 3, "used": 0})), \
                        patch("optimization.controller.optimization_jobs", AsyncMock(return_value=[])):
                    await controller.on_job_finished(self.db, self.job)
                    changed_at = [item.updated_at for item in self.evaluations]
                    await controller.on_job_finished(self.db, self.job)
                linked.assert_awaited_once()
                self.assertEqual(changed_at, [item.updated_at for item in self.evaluations])
                self.assertEqual(identities, [(item.id, item.trial_id, item.source) for item in self.evaluations])
                self.assertEqual([item.state for item in self.evaluations],
                    ["pending" if outcome in {"succeeded", "resource-wait"} else outcome] * 2)
                self.assertEqual([item.next_stage for item in self.evaluations],
                    ["calculate" if outcome == "succeeded" else "predict"] * 2)
                self.assertIsNone(self.optimization.best_trial_id)
                self.assertTrue(all(trial.state == "pending" for trial in self.trials))
                self.db.add.assert_not_called()

    async def test_completed_prediction_calculation_cannot_become_verified_best(self):
        self.submission.stage = "calculate"
        for item in self.evaluations:
            item.next_stage = "calculate"
        self.db.scalar.side_effect = [self.optimization, self.submission]
        with patch("optimization.controller.submission_evaluations", AsyncMock(return_value=self.evaluations)):
            await controller.on_job_finished(self.db, self.job)
        self.assertTrue(all(item.state == "succeeded" for item in self.evaluations))
        self.assertIsNone(self.optimization.best_trial_id)
        self.db.add.assert_not_called()

    async def test_retry_receipt_preserves_prediction_identity_and_waits_for_child_cleanup(self):
        evaluation = self.evaluations[0]
        evaluation.state, evaluation.error = "failed", {"message": "predict failed"}
        self.optimization.state = "paused"
        self.db.scalar.side_effect = None
        self.db.scalar.return_value = evaluation
        request_id = str(uuid4())
        identity = (evaluation.id, evaluation.trial_id, deepcopy(evaluation.source))
        child = SimpleNamespace(state="cancelled", launcher_id="launcher", cleaned_at=None)
        self.db.scalars.return_value = SimpleNamespace(all=lambda: [child])
        with patch("optimization.service.serialize_events", AsyncMock()), \
                patch("optimization.service.require_optimization", AsyncMock(return_value=self.optimization)), \
                patch("optimization.service.optimization_detail", AsyncMock(return_value={"id": self.optimization.id})), \
                patch("optimization.controller.optimization_jobs", AsyncMock(return_value=[])), \
                patch("optimization.controller.wake_controller"), \
                patch("optimization.submissions.submit_stage", AsyncMock()) as submit:
            with self.assertRaises(HTTPException) as rejected:
                await service.retry_evaluation(self.db, self.optimization.id, evaluation.id, request_id, None, None)
            self.assertIn("cleanup", rejected.exception.detail)
            self.assertEqual(evaluation.retry_requests, [])
            self.assertEqual(evaluation.state, "failed")
            child.cleaned_at = "reaped"
            first = await service.retry_evaluation(self.db, self.optimization.id, evaluation.id, request_id, None, None)
            second = await service.retry_evaluation(self.db, self.optimization.id, evaluation.id, request_id, None, None)
        self.assertEqual(first, second)
        self.assertEqual(evaluation.retry_requests, [request_id])
        self.assertEqual((evaluation.id, evaluation.trial_id, evaluation.source), identity)
        self.assertEqual((evaluation.state, evaluation.next_stage), ("pending", "predict"))
        submit.assert_not_awaited()
        self.db.add.assert_not_called()

    async def test_capacity_wait_creates_nothing_and_mixed_revisions_fail_before_admission(self):
        candidates = list(zip(self.trials, self.evaluations))
        with patch("optimization.predictor_jobs.predictor_parent_available", AsyncMock(return_value=False)) as available:
            self.assertIsNone(await submissions.submit_predictions(self.db, self.optimization, candidates))
            self.assertIsNone(await submissions.submit_predictions(self.db, self.optimization, candidates))
            self.evaluations[1].source["model_revision"] += 1
            with self.assertRaisesRegex(ValueError, "one frozen model source"):
                await submissions.submit_predictions(self.db, self.optimization, candidates)
        self.assertEqual(available.await_count, 2)
        self.assertTrue(all(item.state == "running" for item in self.evaluations))
        self.db.add.assert_not_called()
        self.db.flush.assert_not_awaited()

    async def test_solver_retry_reserves_once_and_exhausted_budget_rejects_without_receipt(self):
        for used, reserved in ((0, 1), (1, 0), (0, 2), (2, 0)):
            with self.subTest(used=used, reserved=reserved):
                self.setUp()
                evaluation = self.evaluations[0]
                evaluation.kind, evaluation.state, evaluation.next_stage = "solver", "failed", "solve"
                evaluation.measurement_id = None
                evaluation.error = {"message": "solver failed"}
                self.optimization.state = "paused"
                self.optimization.settings["hybrid"] = {"max_solver_runs": 2}
                self.db.scalar.side_effect = None
                self.db.scalar.return_value = evaluation
                counts = [used, reserved]
                self.db.execute = AsyncMock(side_effect=lambda *_: SimpleNamespace(one=lambda: tuple(counts)))
                request_id = str(uuid4())
                jobs = []

                async def reserve(*_):
                    jobs.append({"id": str(uuid4()), "evaluation_id": evaluation.id, "state": "queued"})
                    counts[1] += 1

                with patch("optimization.service.serialize_events", AsyncMock()), \
                        patch("optimization.service.require_optimization", AsyncMock(return_value=self.optimization)), \
                        patch("optimization.service.optimization_detail", AsyncMock(return_value={"id": self.optimization.id})), \
                        patch("optimization.controller.optimization_jobs", AsyncMock(return_value=[])), \
                        patch("optimization.controller.wake_controller"), \
                        patch("optimization.submissions.submit_stage", AsyncMock(side_effect=reserve)) as submit:
                    if used + reserved == 2:
                        with self.assertRaises(HTTPException) as denied:
                            await service.retry_evaluation(self.db, self.optimization.id, evaluation.id, request_id, None, None)
                        self.assertIn("budget is exhausted", denied.exception.detail)
                        self.assertEqual(evaluation.retry_requests, [])
                        self.assertEqual(evaluation.state, "failed")
                        self.assertFalse(evaluation.manual_retry_requested)
                        self.assertEqual(jobs, [])
                        submit.assert_not_awaited()
                        self.db.commit.assert_not_awaited()
                    else:
                        first = await service.retry_evaluation(self.db, self.optimization.id, evaluation.id, request_id, None, None)
                        second = await service.retry_evaluation(self.db, self.optimization.id, evaluation.id, request_id, None, None)
                        self.assertEqual(first, second)
                        self.assertEqual(evaluation.retry_requests, [request_id])
                        self.assertEqual((evaluation.state, evaluation.next_stage), ("pending", "solve"))
                        self.assertEqual(len(jobs), 1)
                        self.assertEqual(sum(counts), 2)
                        submit.assert_awaited_once()
                self.db.execute.assert_awaited_once()

    async def test_json_restored_round_dispatches_original_revision_and_candidate_ids(self):
        initial = deepcopy(self.source)
        updated = {**initial, "model_revision": 4, "checksum": "b" * 64}
        self.optimization.optimizer_state = json.loads(json.dumps({"runtime_id": "saved-runtime", "model_update": {
            "initial_model": initial, "active_model": updated, "round_model": initial,
            "pending_model": None, "updates": [], "waiting": False}}))
        for item in self.evaluations:
            item.source = round_source(self.optimization)
        added = []
        self.db.add.side_effect = added.append
        self.db.scalar.side_effect = None
        self.db.scalar.return_value = 0

        async def flush():
            for item in added:
                if hasattr(item, "id") and item.id is None:
                    item.id = str(uuid4())

        self.db.flush.side_effect = flush
        with patch("optimization.predictor_jobs.predictor_parent_available", AsyncMock(return_value=True)), \
                patch("optimization.submissions.add_event", AsyncMock()):
            await submissions.submit_predictions(self.db, self.optimization, list(zip(self.trials, self.evaluations)))
        jobs = [item for item in added if getattr(item, "handler_type", None) == "cae.evaluation.predict"]
        self.assertEqual(len(jobs), 1)
        payload = jobs[0].input
        self.assertEqual((payload["hybrid"]["revision"], payload["hybrid"]["checksum"]), (3, "a" * 64))
        self.assertEqual(payload["hybrid"]["dataset_id"], initial["dataset_id"])
        self.assertEqual(payload["runtime_id"], "saved-runtime")
        self.assertEqual([(item["candidate_id"], item["evaluation_id"]) for item in payload["candidates"]],
            [(trial.id, evaluation.id) for trial, evaluation in zip(self.trials, self.evaluations)])
