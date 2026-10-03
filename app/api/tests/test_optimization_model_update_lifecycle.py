"""Hybrid model handoff with saved metadata and fake evaluations; no DB or workers."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from gpstation.db import Job
from optimization.algorithm import variables_fingerprint
from optimization.configuration import ModelUpdatePolicy
from optimization.db import Evaluation, Trial
from optimization.evaluations import freeze_quality
from optimization.hybrid import reconcile_hybrid
from optimization.model_updates import model_state, save_state
from optimization.search import advance_search, initialize_search
from prediction.common import digest
from prediction.db import DatasetRevision, ModelRevision, Operation, Replica, TrainingRun
from test_hybrid_quality import limits, saved_revision


class ModelUpdateLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.enterContext(patch("optimization.automatic_updates.utcnow", return_value=self.now))
        self.enterContext(patch("optimization.model_updates.sync_pins", new_callable=AsyncMock))
        self.enterContext(patch("optimization.controller.optimization_jobs", AsyncMock(return_value=[])))
        self.submit_training = self.enterContext(patch("prediction.training.submit", AsyncMock(
            side_effect=AssertionError("This fixture must never submit training."))))
        self.cancel_training = self.enterContext(patch("prediction.training.cancel", AsyncMock(side_effect=self.cancel)))
        self.submit_predictions = self.enterContext(patch("optimization.hybrid.submit_predictions", AsyncMock(side_effect=self.predict)))
        self.submit_solver = self.enterContext(patch("optimization.hybrid.submit_stage", AsyncMock(
            side_effect=AssertionError("This fixture must never submit Solver work."))))
        self.configure()

    def configure(self, algorithm="random", *, quality=False):
        initial = saved_revision()
        if not quality:
            initial.artifact.pop("quality_report")
            initial.definition.pop("qualityValidation")
        self.source = {"model_id": "model", "model_revision": 1, "replica_id": "initial-copy",
            "storage_id": "storage", "launcher_id": "launcher", "checksum": "checksum",
            "dataset_id": initial.dataset_id, "dataset_revision": 1, "dataset_fingerprint": "snapshot",
            "model_definition": initial.definition, "source_contracts": initial.source_contracts,
            "quality_requirements": limits() if quality else None,
            **freeze_quality(initial, limits() if quality else None)}
        configurations = {"coordinate": {}, "random": {"seed": 42, "candidates_per_round": 2},
                          "de": {"seed": 42, "population_size": 4}}
        settings = {"algorithm": {"id": algorithm, "config": configurations[algorithm]},
            "initial_vars": {"x": 0.5}, "axes": [{"name": "x", "indices": [], "min": 0, "max": 1, "fixed": False}],
            "objective": {"direction": "minimize"}, "constraints": [],
            "max_trials": 8 if algorithm == "de" else 5, "max_parallel": 2,
            "hybrid": {"max_solver_runs": 5}}
        self.optimization = SimpleNamespace(id="optimization", user_id="owner", experiment_id=7,
            state="running", pause_reason=None, settings=settings,
            definition={"hash": "definition", "source_hash": "source", "catalog_revision": "catalog",
                        "hybrid": deepcopy(self.source)}, optimizer_state=initialize_search(settings))
        state = model_state(self.optimization)
        state["updates"] = [{"model_id": "model", "revision": 2, "operation_id": "operation",
                             "version_name": "revision 2", "state": "running"}]
        save_state(self.optimization, state)
        self.optimization.optimizer_state.update(selection=["trial-1"], round_source_hash=digest(self.source),
            round_sources={"0": deepcopy(self.source)}, runtime_id="saved-runtime")
        self.trials = [SimpleNamespace(id="trial-1", ordinal=1, round_index=0, variables={"x": 0.5},
            fingerprint=variables_fingerprint({"x": 0.5}), state="succeeded", next_stage="complete")]
        self.evaluations = [SimpleNamespace(id=kind, trial_id="trial-1", fingerprint=self.trials[0].fingerprint,
            kind=kind, state="succeeded", next_stage="complete", manual_retry_requested=False,
            definition_hash="definition", source_hash=digest(self.source) if kind == "prediction" else "source",
            source=deepcopy(self.source) if kind == "prediction" else {"source_hash": "source"},
            result={"objective": -100 if kind == "prediction" else 10, "feasible": True, "violation": 0})
            for kind in ("prediction", "solver")]
        if algorithm == "de":
            # Complete a real initial proposal, with only two actually verified members.
            state, candidates, _, _ = advance_search([], [], settings, self.optimization.optimizer_state,
                                                      {"remaining": 5})
            state["selection"] = ["trial-1", "trial-2"]
            self.optimization.optimizer_state = state
            self.trials = [SimpleNamespace(**candidate, id=f"trial-{candidate['ordinal']}", state="succeeded",
                                          next_stage="complete") for candidate in candidates]
            templates = {item.kind: item for item in self.evaluations}
            self.evaluations = [SimpleNamespace(**{**deepcopy(vars(templates[kind])),
                "id": f"{kind}-{trial.ordinal}", "trial_id": trial.id, "fingerprint": trial.fingerprint})
                for trial in self.trials for kind in ("prediction", "solver")
                if kind == "prediction" or trial.ordinal <= 2]
        self.revision = deepcopy(initial)
        self.revision.revision = self.revision.dataset_revision = 2
        self.revision.dataset_fingerprint = "snapshot-2"
        self.revision.definition = {**initial.definition, "snapshotFingerprint": "snapshot-2"}
        self.revision.artifact.update(manifest_sha256="next-checksum", validation={
            "manifestChecksum": "next-checksum", "loadPassed": True, "predictPassed": True})
        if quality:
            self.revision.artifact["quality_report"]["dataset"].update(revision=2, fingerprint="snapshot-2")
        self.operation = SimpleNamespace(id="operation", state="running", error=None, completed_at=None,
            updated_at=self.now, details={"result_replicas": {"model": "next-copy"}})
        self.run = SimpleNamespace(job_id="training-job", pin_id="training-pin")
        self.job = SimpleNamespace(state="running", launcher_id="launcher", cleaned_at=None, finished_at=None)
        self.objects = {Operation: self.operation, TrainingRun: self.run, Job: self.job,
            ModelRevision: self.revision, Replica: SimpleNamespace(id="next-copy", state="present",
                manifest_sha256="next-checksum"),
            DatasetRevision: SimpleNamespace(fingerprint="snapshot", summary={"sample_fingerprints": {"1": "sample"}})}
        self.db = SimpleNamespace(get=AsyncMock(side_effect=lambda kind, identity: self.objects[kind]),
            scalars=AsyncMock(), scalar=AsyncMock(side_effect=self.lookup_evaluation),
            execute=AsyncMock(return_value=SimpleNamespace(one=lambda: (1, 0))),
            add=Mock(side_effect=self.add), flush=AsyncMock(), begin_nested=Mock(return_value=AsyncMock()))
        self.catalog = SimpleNamespace(meta=lambda: {"catalogRevision": "catalog"})

    def lookup_evaluation(self, statement):
        if statement.column_descriptions[0]["entity"] is not Evaluation:
            return 0  # No additional Measurements for the automatic-update policy.
        parameters = statement.compile().params
        return next((item for item in self.evaluations
            if item.fingerprint == parameters["fingerprint_1"] and item.kind == parameters["kind_1"]
            and item.source_hash == parameters["source_hash_1"]), None)

    def add(self, row):
        if isinstance(row, Trial):
            row.id = f"trial-{row.ordinal}"
            self.trials.append(row)
        else:
            self.assertIsInstance(row, Evaluation)
            row.id = f"evaluation-{len(self.evaluations) + 1}"
            self.evaluations.append(row)

    async def predict(self, db, optimization, pairs):
        # Admission is an I/O seam; no Predictor process or artifact is needed.
        for _, evaluation in pairs:
            evaluation.state = "running"

    async def cancel(self, db, operation):
        self.assertIs(operation, self.operation)
        self.assertEqual(self.run.job_id, "training-job")
        operation.state, operation.completed_at = "cancelled", self.now
        self.job.state, self.job.finished_at = "cancelled", self.now
        # Cleanup remains outstanding until the test supplies its receipt.

    async def advance(self):
        self.db.scalars.side_effect = [SimpleNamespace(all=lambda rows=rows: list(rows))
            for rows in (list(self.trials), list(self.evaluations), [], [])]
        await reconcile_hybrid(self.db, self.optimization, self.catalog)
        self.submit_training.assert_not_awaited()
        self.submit_solver.assert_not_awaited()

    def complete_training(self):
        self.operation.state, self.operation.completed_at = "completed", self.now
        self.job.state, self.job.finished_at, self.job.cleaned_at = "succeeded", self.now, self.now

    def snapshot(self):
        return deepcopy({"state": self.optimization.optimizer_state,
            "trials": [{key: getattr(item, key) for key in ("id", "ordinal", "variables", "fingerprint")}
                       for item in self.trials],
            "evaluations": [{key: getattr(item, key) for key in
                ("id", "trial_id", "kind", "state", "next_stage", "source", "source_hash", "result")}
                for item in self.evaluations]})

    async def test_ready_model_keeps_current_round_then_is_adopted_once(self):
        self.evaluations[1].state = "running"
        original = self.snapshot()
        self.complete_training()
        for _ in range(2):
            await self.advance()
            state = model_state(self.optimization)
            self.assertEqual(state["active_model"], self.source)
            self.assertEqual(state["round_model"], self.source)
            self.assertEqual(state["pending_model"]["model_revision"], 2)
            self.assertEqual(self.snapshot()["evaluations"], original["evaluations"])
            self.assertEqual(self.snapshot()["trials"], original["trials"])
        self.submit_predictions.assert_not_awaited()
        self.evaluations[1].state = "succeeded"
        old_evaluations = self.snapshot()["evaluations"]
        await self.advance()
        adopted = self.snapshot()
        state = model_state(self.optimization)
        self.assertEqual((state["active_model"]["model_revision"], state["round_model"]["model_revision"]), (2, 2))
        self.assertEqual((state["updates"][0]["state"], state["updates"][0]["adopted_round"]), ("adopted", 1))
        self.assertIsNone(state["pending_model"])
        self.assertEqual(adopted["evaluations"][:2], old_evaluations)
        self.assertEqual([item.source["model_revision"] for item in self.evaluations[2:]], [2, 2])
        self.assertEqual(adopted["state"]["round_sources"]["0"], self.source)
        for _ in range(2):
            await self.advance()
            self.assertEqual(self.snapshot(), adopted)
        self.submit_predictions.assert_awaited_once()

    async def test_waiting_and_json_resume_match_uninterrupted_candidates_and_model_sources(self):
        for algorithm in ("coordinate", "random", "de"):
            with self.subTest(algorithm=algorithm):
                self.configure(algorithm)
                self.complete_training()
                await self.advance()
                uninterrupted = self.snapshot()
                self.configure(algorithm)
                saved = self.snapshot()
                for _ in range(3):
                    await self.advance()
                    state = self.optimization.optimizer_state
                    self.assertEqual({key: value for key, value in state.items() if key != "model_update"},
                                     {key: value for key, value in saved["state"].items() if key != "model_update"})
                    self.assertTrue(model_state(self.optimization)["waiting"])
                    self.assertEqual(self.snapshot()["trials"], saved["trials"])
                    self.assertEqual(self.snapshot()["evaluations"], saved["evaluations"])
                    self.optimization.optimizer_state = json.loads(json.dumps(state))
                    self.trials = [SimpleNamespace(**json.loads(json.dumps(vars(item)))) for item in self.trials]
                    self.evaluations = [SimpleNamespace(**json.loads(json.dumps(vars(item)))) for item in self.evaluations]
                self.complete_training()
                await self.advance()
                self.assertEqual(self.snapshot(), uninterrupted)

    async def test_failed_cancelled_or_rejected_update_continues_with_original_model(self):
        for outcome in ("failed", "cancelled", "load-rejected", "predict-rejected", "quality-rejected"):
            with self.subTest(outcome=outcome):
                self.configure(quality=outcome == "quality-rejected")
                original = self.snapshot()
                expected, candidates, _, _ = advance_search(self.trials, self.evaluations,
                    self.optimization.settings, self.optimization.optimizer_state, {"remaining": 4})
                await self.advance()
                if outcome in {"failed", "cancelled"}:
                    self.operation.state = self.job.state = outcome
                    self.operation.error = {"message": "fixture training failure"}
                else:
                    self.complete_training()
                    if outcome == "quality-rejected":
                        self.revision.artifact["quality_report"]["records"][0]["components"][0].update(
                            rmse=2, mae=2, maxAbsoluteError=2)
                    else:
                        self.revision.artifact["validation"]["loadPassed" if outcome == "load-rejected" else "predictPassed"] = False
                self.job.cleaned_at = self.now
                await self.advance()
                state = model_state(self.optimization)
                self.assertEqual(self.optimization.state, "running")
                self.assertEqual(state["active_model"], self.source)
                self.assertEqual(state["round_model"], self.source)
                self.assertIsNone(state["pending_model"])
                self.assertEqual(state["updates"][0]["state"], "cancelled" if outcome == "cancelled" else "failed")
                self.assertEqual(self.optimization.optimizer_state["algorithm_state"], expected["algorithm_state"])
                self.assertEqual([item.variables for item in self.trials[1:]], [item["variables"] for item in candidates])
                self.assertEqual(self.snapshot()["evaluations"][:2], original["evaluations"])
                self.assertTrue(all(item.source == self.source for item in self.evaluations[2:]))
                continued = self.snapshot()
                await self.advance()
                self.assertEqual(self.snapshot(), continued)

    async def test_timeout_cancels_once_waits_for_cleanup_and_retains_random_state(self):
        self.optimization.settings["hybrid"]["model_update_policy"] = ModelUpdatePolicy().model_dump()
        state = model_state(self.optimization)
        state["updates"][0]["automatic_attempt"] = {"pin_id": self.run.pin_id, "job_id": self.run.job_id,
            "started_at": (self.now - timedelta(seconds=181)).isoformat(),
            "deadline_at": (self.now - timedelta(seconds=1)).isoformat()}
        save_state(self.optimization, state)
        original = self.snapshot()
        expected, candidates, _, _ = advance_search(self.trials, self.evaluations,
            self.optimization.settings, self.optimization.optimizer_state, {"remaining": 4})
        for _ in range(2):
            await self.advance()
            state = model_state(self.optimization)
            self.assertEqual(state["updates"][0]["state"], "timed_out")
            self.assertTrue(state["waiting"])
            self.assertEqual(state["active_model"], self.source)
            self.assertEqual(self.snapshot()["trials"], original["trials"])
            self.assertEqual(self.optimization.optimizer_state["algorithm_state"], original["state"]["algorithm_state"])
            self.optimization.optimizer_state = json.loads(json.dumps(self.optimization.optimizer_state))
        self.cancel_training.assert_awaited_once()
        self.job.cleaned_at = self.now
        await self.advance()
        self.assertEqual(self.optimization.state, "running")
        self.assertEqual(self.optimization.optimizer_state["algorithm_state"], expected["algorithm_state"])
        self.assertEqual([item.variables for item in self.trials[1:]], [item["variables"] for item in candidates])
        self.assertTrue(all(item.source == self.source for item in self.evaluations[2:]))
        state = model_state(self.optimization)
        self.assertFalse(state["waiting"])
        self.assertEqual((state["automatic"]["attempts"], state["automatic"]["elapsed_seconds"]), (1, 181))
        continued = self.snapshot()
        await self.advance()
        self.assertEqual(self.snapshot(), continued)
        self.cancel_training.assert_awaited_once()
