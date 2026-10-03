"""Hybrid persistence and strict Solver admission on disposable PostgreSQL; no Solver calls."""
import asyncio
import os
import unittest
import uuid

from fastapi import HTTPException
from sqlalchemy import func, select

import test_optimization_controller as fixtures
from gpstation.db import Job, Launcher
from gpstation.service.batches import finish_job, serialize_events
from gpstation.service.server_handlers import register_server_handler
from gpstation.service.state import utcnow
from optimization import evaluation, integration
from optimization.algorithm import variables_fingerprint
from optimization.controller import cancel_optimization
from optimization.db import Evaluation, EvaluationSubmission, Optimization, StageSubmission, Trial
from optimization.evaluations import ensure_evaluation, solver_budget
from optimization.service import create_optimization, delete_optimization, list_trials, optimization_detail, resume_optimization, retry_evaluation
from optimization.submissions import submit_predictions, submit_stage
from prediction.db import Dataset, ModelRevision, PredictionModel, PredictionStorage, Replica, StorageAccess
from simulation.db import Measurement
from storage.db import StorageObject
from storage.service import reference


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class HybridOptimizationTests(unittest.IsolatedAsyncioTestCase):
    setUpClass = classmethod(fixtures.OptimizationControllerTests.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.OptimizationControllerTests.tearDownClass.__func__)
    asyncTearDown = fixtures.OptimizationControllerTests.asyncTearDown
    request = fixtures.OptimizationControllerTests.request
    create = fixtures.OptimizationControllerTests.create
    advance = fixtures.OptimizationControllerTests.advance
    jobs = fixtures.OptimizationControllerTests.jobs
    complete = fixtures.OptimizationControllerTests.complete

    async def asyncSetUp(self):
        await fixtures.OptimizationControllerTests.asyncSetUp(self)
        register_server_handler("cae.evaluation.predict", evaluation,
                                event_context=integration.event_context, on_finished=integration.on_finished)

    async def hybrid(self, *, limit=2, count=3):
        optimization_id = await self.create(max_trials=count)
        async with self.sessions() as db:
            launcher = Launcher(user_id=self.owner.id, launcher_name="Hybrid test", status="ready",
                connected_at=utcnow(), last_heartbeat_at=utcnow(), slave_app_ids=["evaluation", "predictor"],
                job_modes={"evaluation": "websocket", "predictor": "webrtc"}, resources={"cpu_total": 2,
                    "cpu_reserved": 0, "ram_budget_bytes": 1000, "defaults": {
                        "evaluation": {"startup_ram_bytes": 100}, "predictor": {"startup_ram_bytes": 100}}})
            db.add(launcher)
            await db.flush()
            optimization = await db.get(Optimization, optimization_id)
            hybrid = {"model_id": str(uuid.uuid4()), "model_revision": 1, "replica_id": str(uuid.uuid4()),
                "storage_id": str(uuid.uuid4()), "launcher_id": launcher.id, "max_solver_runs": limit,
                "checksum": "a" * 64, "dataset_id": str(uuid.uuid4()), "dataset_revision": 1,
                "dataset_fingerprint": "dataset", "model_definition": {}, "source_contracts": {"records": []},
                "resources": {"evaluation": {"cpu_cores": 1, "startup_ram_bytes": 100, "gpu_count": 0},
                              "predictor": {"cpu_cores": 1, "startup_ram_bytes": 100, "gpu_count": 0}}}
            # Freeze validation is covered separately; these tests exercise admission
            # and transitions using the same persisted state after successful creation.
            optimization.settings = {**optimization.settings, "hybrid": hybrid}
            optimization.definition = {**optimization.definition, "hybrid": hybrid}
            await db.commit()
        return optimization_id

    async def candidates(self, optimization_id, count=1, *, solver=False):
        identities = []
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            for ordinal in range(1, count + 1):
                variables = {"x": [ordinal + 3, 5]}
                trial = Trial(optimization_id=optimization_id, ordinal=ordinal, round_index=0,
                    variables=variables, fingerprint=variables_fingerprint(variables), state="pending", next_stage="build")
                db.add(trial)
                await db.flush()
                predicted = await ensure_evaluation(db, optimization, trial, "prediction")
                predicted.state, predicted.next_stage = "succeeded", "complete"
                predicted.result = {"objective": ordinal, "feasible": True, "violation": 0, "constraints": []}
                verified = await ensure_evaluation(db, optimization, trial, "solver") if solver else None
                if verified:
                    await submit_stage(db, optimization, trial, self.catalog, verified)
                identities.append((trial.id, predicted.id, verified.id if verified else None))
            optimization.optimizer_state = {**optimization.optimizer_state,
                "round_ordinals": list(range(1, count + 1)),
                "selection": [item[0] for item in identities] if solver else [], "round_index": 0}
            await db.commit()
        if solver:
            for job in await self.jobs(optimization_id):
                if job.handler_type == "cae.evaluation.build" and job.state == "queued":
                    await self.complete(job.id)
        return identities

    async def submit_solver(self, optimization_id, evaluation_id):
        async with self.sessions() as db:
            await serialize_events(db)
            optimization = await db.scalar(select(Optimization).where(Optimization.id == optimization_id).with_for_update())
            item = await db.get(Evaluation, evaluation_id)
            trial = await db.get(Trial, item.trial_id)
            submission = await submit_stage(db, optimization, trial, self.catalog, item)
            await db.commit()
            return submission.job_id

    async def started(self, job_id):
        async with self.sessions() as db:
            job = await db.get(Job, job_id)
            job.started_at, job.state = utcnow(), "running"
            await db.commit()

    async def test_same_vars_keep_prediction_solver_results_and_revision_identity(self):
        optimization_id = await self.hybrid()
        trial_id, predicted_id, _ = (await self.candidates(optimization_id))[0]
        async with self.sessions() as db:
            optimization, trial = await db.get(Optimization, optimization_id), await db.get(Trial, trial_id)
            predicted = await ensure_evaluation(db, optimization, trial, "prediction")
            self.assertEqual(predicted.id, predicted_id)
            verified = await ensure_evaluation(db, optimization, trial, "solver")
            verified.state, verified.next_stage = "succeeded", "complete"
            verified.result = {"objective": 9, "feasible": True, "violation": 0, "constraints": []}
            await db.flush()
            summary = await optimization_detail(db, optimization)
            self.assertEqual(summary["best_predicted_trial"]["result"]["objective"], 1)
            self.assertEqual(summary["best_verified_trial"]["result"]["objective"], 9)
            self.assertEqual(summary["best_trial"], summary["best_verified_trial"])
            self.assertIsNone(predicted.measurement_id)
            frozen_definition = optimization.definition
            second_revision = await ensure_evaluation(db, optimization, trial, "prediction",
                prediction_source={**optimization.definition["hybrid"], "model_revision": 2})
            self.assertEqual(optimization.definition, frozen_definition)
            self.assertNotEqual(second_revision.id, predicted.id)
            self.assertNotEqual(second_revision.source_hash, predicted.source_hash)
            history = await list_trials(db, optimization, limit=20, offset=0)
            self.assertEqual(len(history["items"][0]["evaluations"]), 3)

    async def test_one_prediction_batch_counts_and_cancels_one_physical_job(self):
        optimization_id = await self.hybrid()
        identities = await self.candidates(optimization_id, 2)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            pairs = [(await db.get(Trial, trial), await db.get(Evaluation, predicted)) for trial, predicted, _ in identities]
            for _, item in pairs:
                item.state, item.next_stage, item.result = "pending", "predict", None
            await submit_predictions(db, optimization, pairs)
            await db.commit()
            summary = await optimization_detail(db, optimization)
            self.assertEqual(summary["executions_active"], 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(StageSubmission)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(EvaluationSubmission)), 2)
            page = await list_trials(db, optimization, limit=1, offset=1)
            self.assertEqual(page["items"][0]["id"], identities[1][0])
            self.assertEqual(len(page["items"][0]["evaluations"][0]["stages"]), 1)
            self.assertIsNone(page["items"][0]["evaluations"][0]["stages"][0]["job"]["measurement_id"])
            await cancel_optimization(db, optimization)
            await db.commit()
            self.assertEqual([item.state for _, item in pairs], ["cancelled", "cancelled"])
            self.assertEqual(await db.scalar(select(func.count()).select_from(Measurement)), 0)
        self.assertEqual(len(await self.jobs(optimization_id)), 1)

    async def test_late_old_revision_response_keeps_its_source_and_cannot_replace_current_best(self):
        from optimization.model_updates import bind_round, model_state, save_state

        optimization_id = await self.hybrid()
        trial_id, prediction_id, _ = (await self.candidates(optimization_id))[0]
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            trial, old = await db.get(Trial, trial_id), await db.get(Evaluation, prediction_id)
            old.state, old.next_stage, old.result = "pending", "predict", None
            submission = await submit_predictions(db, optimization, [(trial, old)])
            job = await db.get(Job, submission.job_id)
            state = model_state(optimization)
            state["pending_model"] = {**old.source, "model_revision": 2, "checksum": "b" * 64}
            save_state(optimization, state)
            await bind_round(db, optimization, 1)
            current = await ensure_evaluation(db, optimization, trial, "prediction")
            current.state, current.next_stage = "succeeded", "complete"
            current.result = {"objective": 20, "feasible": True, "violation": 0, "constraints": []}
            stored = StorageObject(id=str(uuid.uuid4()), user_id=self.owner.id, experiment_id=self.experiment_id,
                purpose="evaluation", job_id=job.id, attempt=job.attempt_count, ready=True,
                manifest={"encoding": "json", "sha256": "c" * 64, "byteLength": 2, "chunks": []})
            db.add(stored)
            await db.flush()
            await evaluation.stage_record(db, job, {"sequence": 1, "name": "predict", "value": {
                "candidates": [{"candidate_id": trial.id, "evaluation_id": old.id, "artifact": reference(stored)}],
                "provenance": {"model_id": old.source["model_id"], "revision": 1, "checksum": "a" * 64},
            }}, [])
            await db.flush()
            result = await evaluation.complete_job(db, job, {"recordSequences": [1],
                "definition_hash": optimization.definition["hash"], "runtime_id": "test-runtime"})
            await finish_job(db, job, "succeeded", result=result)
            self.assertEqual((old.source["model_revision"], old.next_stage), (1, "calculate"))
            old.state, old.next_stage = "succeeded", "complete"
            old.result = {"objective": -100, "feasible": True, "violation": 0, "constraints": []}
            await db.flush()
            summary = await optimization_detail(db, optimization)
            self.assertEqual(summary["best_predicted_trial"]["evaluation_id"], current.id)
            self.assertEqual(summary["best_predicted_trial"]["source"]["model_revision"], 2)
            self.assertEqual(summary["best_predicted_trial"]["result"]["objective"], 20)
            self.assertEqual(optimization.definition["hybrid"]["model_revision"], 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(Evaluation)), 2)
            await db.commit()

    async def test_last_solver_reservation_is_atomic_and_prestart_cancel_returns_it(self):
        optimization_id = await self.hybrid(limit=1)
        identities = await self.candidates(optimization_id, 2, solver=True)
        results = await asyncio.gather(*(self.submit_solver(optimization_id, item[2]) for item in identities), return_exceptions=True)
        accepted = [item for item in results if isinstance(item, str)]
        denied = [item for item in results if isinstance(item, HTTPException)]
        self.assertEqual((len(accepted), len(denied)), (1, 1), results)
        self.assertEqual(denied[0].status_code, 409)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            self.assertEqual(await solver_budget(db, optimization), {"limit": 1, "used": 0, "reserved": 1, "remaining": 0})
            await cancel_optimization(db, optimization)
            await db.commit()
            self.assertEqual(await solver_budget(db, optimization), {"limit": 1, "used": 0, "reserved": 0, "remaining": 1})

    async def test_failure_and_cancellation_return_only_unstarted_solver_reservations(self):
        for started in (False, True):
            for outcome in ("failed", "cancelled"):
                with self.subTest(started=started, outcome=outcome):
                    optimization_id = await self.hybrid(limit=2, count=1)
                    _, _, evaluation_id = (await self.candidates(optimization_id, solver=True))[0]
                    job_id = await self.submit_solver(optimization_id, evaluation_id)
                    async with self.sessions() as db:
                        optimization = await db.get(Optimization, optimization_id)
                        self.assertEqual(await solver_budget(db, optimization),
                            {"limit": 2, "used": 0, "reserved": 1, "remaining": 1})
                    if started:
                        await self.started(job_id)
                    async with self.sessions() as db:
                        await serialize_events(db)
                        optimization = await db.get(Optimization, optimization_id)
                        job = await db.get(Job, job_id)
                        self.assertEqual(await solver_budget(db, optimization),
                            {"limit": 2, "used": int(started), "reserved": int(not started), "remaining": 1})
                        if outcome == "cancelled":
                            await cancel_optimization(db, optimization)
                        else:
                            self.assertTrue(await finish_job(db, job, "failed", "fixture Solver failure"))
                        await db.commit()
                        self.assertEqual((job.state, job.started_at is not None), (outcome, started))
                        # A repeated terminal notification must not spend or refund twice.
                        self.assertFalse(await finish_job(db, job, outcome, "replayed terminal notification"))
                        await db.commit()
                    async with self.sessions() as db:
                        optimization = await db.get(Optimization, optimization_id)
                        self.assertEqual(await solver_budget(db, optimization),
                            {"limit": 2, "used": int(started), "reserved": 0, "remaining": 2 - int(started)})
                        item = await db.get(Evaluation, evaluation_id)
                        self.assertEqual(item.state, outcome)
                    self.assertEqual(sum(job.handler_type == "cae.simulation"
                        for job in await self.jobs(optimization_id)), 1)

    async def test_solver_retry_reserves_once_and_final_failure_retains_used_budget(self):
        optimization_id = await self.hybrid(limit=2, count=1)
        _, _, evaluation_id = (await self.candidates(optimization_id, solver=True))[0]
        first = await self.submit_solver(optimization_id, evaluation_id)
        await self.started(first)
        await self.complete(first, failure="first Solver failed")
        await self.advance(optimization_id)
        request_id = str(uuid.uuid4())
        async def retry():
            async with self.sessions() as db:
                return await retry_evaluation(db, optimization_id, evaluation_id, request_id, self.owner, self.catalog)
        replies = await asyncio.gather(retry(), retry())
        self.assertEqual([reply["solver_budget"] for reply in replies], [{"limit": 2, "used": 1, "reserved": 1, "remaining": 0}] * 2)
        solvers = [job for job in await self.jobs(optimization_id) if job.handler_type == "cae.simulation"]
        self.assertEqual(len(solvers), 2)
        retried = next(job for job in solvers if job.id != first)
        await self.started(retried.id)
        await self.complete(retried.id, failure="last Solver failed")
        await self.advance(optimization_id)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            item = await db.get(Evaluation, evaluation_id)
            self.assertEqual(await solver_budget(db, optimization), {"limit": 2, "used": 2, "reserved": 0, "remaining": 0})
            self.assertEqual((item.state, item.error["message"]), ("failed", "last Solver failed"))
            self.assertEqual(len(item.retry_requests), 1)
            self.assertEqual(optimization.optimizer_state["termination_reason"], "solver_budget_exhausted")
            self.assertEqual(optimization.state, "completed")

    async def test_calculation_retry_reuses_measurement_after_budget_exhaustion(self):
        optimization_id = await self.hybrid(limit=1, count=1)
        _, _, evaluation_id = (await self.candidates(optimization_id, solver=True))[0]
        solve = await self.submit_solver(optimization_id, evaluation_id)
        await self.started(solve)
        await self.complete(solve)
        await self.advance(optimization_id)
        calculate = next(job for job in await self.jobs(optimization_id) if job.handler_type == "cae.evaluation.calculate")
        await self.complete(calculate.id, failure="postprocess failed")
        await self.advance(optimization_id)
        async with self.sessions() as db:
            item = await db.get(Evaluation, evaluation_id)
            measurement_id = item.measurement_id
            await retry_evaluation(db, optimization_id, evaluation_id, str(uuid.uuid4()), self.owner, self.catalog)
        await self.advance(optimization_id)
        retried = next(job for job in await self.jobs(optimization_id) if job.handler_type == "cae.evaluation.calculate" and job.state == "queued")
        await self.complete(retried.id)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            item = await db.get(Evaluation, evaluation_id)
            self.assertEqual((item.measurement_id, item.state), (measurement_id, "succeeded"))
            self.assertEqual(await solver_budget(db, optimization), {"limit": 1, "used": 1, "reserved": 0, "remaining": 0})
        self.assertEqual(sum(job.handler_type == "cae.simulation" for job in await self.jobs(optimization_id)), 1)

    async def test_prediction_failure_and_pending_retry_guard_resume_and_deletion(self):
        optimization_id = await self.hybrid()
        _, prediction_id, _ = (await self.candidates(optimization_id))[0]
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            predicted = await db.get(Evaluation, prediction_id)
            optimization.state = "paused"
            predicted.state, predicted.next_stage = "failed", "predict"
            await db.commit()
            with self.assertRaises(HTTPException):
                await resume_optimization(db, optimization)
            await retry_evaluation(db, optimization_id, prediction_id, str(uuid.uuid4()), self.owner, self.catalog)
            with self.assertRaises(HTTPException):
                await resume_optimization(db, optimization)
            with self.assertRaises(HTTPException):
                await delete_optimization(db, optimization)

    async def test_last_retry_failure_finishes_previously_cancelled_sibling_calculation(self):
        optimization_id = await self.hybrid(limit=3, count=2)
        identities = await self.candidates(optimization_id, 2, solver=True)
        first = await self.submit_solver(optimization_id, identities[0][2])
        second = await self.submit_solver(optimization_id, identities[1][2])
        await self.started(first)
        await self.complete(first)
        await self.advance(optimization_id)
        await self.started(second)
        await self.complete(second, failure="retryable Solver failure")
        await self.advance(optimization_id)
        async with self.sessions() as db:
            cancelled = await db.get(Evaluation, identities[0][2])
            self.assertEqual((cancelled.state, cancelled.next_stage), ("cancelled", "calculate"))
            await retry_evaluation(db, optimization_id, identities[1][2], str(uuid.uuid4()), self.owner, self.catalog)
        retried = next(job for job in await self.jobs(optimization_id) if job.handler_type == "cae.simulation" and job.state == "queued")
        await self.started(retried.id)
        await self.complete(retried.id, failure="final Solver failure")
        await self.advance(optimization_id)
        calculations = [job for job in await self.jobs(optimization_id)
                        if job.handler_type == "cae.evaluation.calculate" and job.state == "queued"]
        self.assertEqual(len(calculations), 1, "Previously recorded output must finish its free Calculation after budget exhaustion.")
        await self.complete(calculations[0].id)
        await self.advance(optimization_id)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            summary = await optimization_detail(db, optimization)
            self.assertEqual(optimization.state, "completed")
            self.assertEqual(summary["solver_budget"], {"limit": 3, "used": 3, "reserved": 0, "remaining": 0})
            self.assertEqual(summary["best_verified_trial"]["id"], identities[0][0])

    async def test_explicit_stop_holds_free_calculation_until_resume(self):
        optimization_id = await self.hybrid(limit=1, count=1)
        _, _, evaluation_id = (await self.candidates(optimization_id, solver=True))[0]
        solve = await self.submit_solver(optimization_id, evaluation_id)
        await self.started(solve)
        await self.complete(solve)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            await cancel_optimization(db, optimization)
            await db.commit()
        await self.advance(optimization_id)
        await self.advance(optimization_id)
        self.assertFalse(any(job.handler_type == "cae.evaluation.calculate" for job in await self.jobs(optimization_id)))
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            self.assertEqual(optimization.state, "paused")
            await resume_optimization(db, optimization)
            await db.commit()
        await self.advance(optimization_id)
        calculate = next(job for job in await self.jobs(optimization_id) if job.handler_type == "cae.evaluation.calculate")
        await self.complete(calculate.id)
        await self.advance(optimization_id)
        async with self.sessions() as db:
            self.assertEqual((await db.get(Optimization, optimization_id)).state, "completed")

    async def model(self):
        scaffold = await self.hybrid()
        async with self.sessions() as db:
            optimization = await db.get(Optimization, scaffold)
            hybrid = optimization.definition["hybrid"]
            dataset = Dataset(id=hybrid["dataset_id"], user_id=self.owner.id, experiment_id=self.experiment_id,
                              name="Hybrid dataset", selection={}, current_revision=1)
            model = PredictionModel(id=hybrid["model_id"], user_id=self.owner.id, experiment_id=self.experiment_id,
                                    name="kNN", direction="forward", current_revision=2)
            storage = PredictionStorage(storage_id=hybrid["storage_id"], user_id=self.owner.id,
                                        name="Predictor", kind="predictor_local")
            db.add_all([dataset, model, storage])
            await db.flush()
            revision = ModelRevision(model_id=model.id, revision=1, request_id=str(uuid.uuid4()), request_hash="model",
                state="ready", dataset_id=dataset.id, dataset_revision=1, dataset_fingerprint=hybrid["dataset_fingerprint"],
                definition={"algorithm": {"kind": "knn"}, "implementationVersion": "knn-v1", "preprocessingVersion": "box-relative-v2"}, source_contracts={
                    "sourceHash": optimization.definition["source_hash"], "varsSchema": optimization.definition["vars_schema"],
                    "resultContracts": optimization.definition["result_contracts"], "records": []},
                artifact={"manifest_sha256": hybrid["checksum"]})
            db.add(revision)
            await db.flush()
            db.add_all([Replica(id=hybrid["replica_id"], model_id=model.id, revision=1,
                        storage_id=storage.storage_id, state="present", manifest_sha256=hybrid["checksum"]),
                        StorageAccess(storage_id=storage.storage_id, launcher_id=hybrid["launcher_id"])])
            await db.commit()
            return {key: hybrid[key] for key in ("model_id", "model_revision", "replica_id", "launcher_id", "max_solver_runs")}

    async def test_creation_pins_exact_saved_revision_and_rejects_changed_or_missing_artifacts(self):
        hybrid = await self.model()
        request = self.request(hybrid=hybrid)
        async with self.sessions() as db:
            created = await create_optimization(db, request, self.owner, self.catalog)
            frozen = created.definition["hybrid"]
            self.assertEqual((frozen["model_revision"], frozen["checksum"]), (1, "a" * 64))
            self.assertEqual((frozen["dataset_revision"], frozen["dataset_fingerprint"]), (1, "dataset"))
            created_id = created.id
        for change, status in (("missing_revision", 409), ("missing_replica", 409), ("checksum", 409),
                               ("source", 409), ("vars", 409), ("owner", 404), ("capacity", 422)):
            with self.subTest(change=change):
                async with self.sessions() as db:
                    config = dict(hybrid)
                    if change == "missing_revision":
                        config["model_revision"] = 2
                    elif change == "missing_replica":
                        (await db.get(Replica, hybrid["replica_id"])).state = "missing"
                    elif change == "checksum":
                        (await db.get(Replica, hybrid["replica_id"])).manifest_sha256 = "b" * 64
                    elif change in {"source", "vars"}:
                        revision = await db.get(ModelRevision, (hybrid["model_id"], 1))
                        revision.source_contracts = {**revision.source_contracts,
                            **({"sourceHash": "b" * 64} if change == "source" else {"varsSchema": {}})}
                    elif change == "owner":
                        (await db.get(PredictionModel, hybrid["model_id"])).user_id = self.other.id
                    elif change == "capacity":
                        launcher = await db.get(Launcher, hybrid["launcher_id"])
                        launcher.resources = {**launcher.resources, "cpu_total": 1}
                    await db.flush()
                    with self.assertRaises(HTTPException) as denied:
                        await create_optimization(db, self.request(hybrid=config), self.owner, self.catalog)
                    self.assertEqual(denied.exception.status_code, status)
                    await db.rollback()
        async with self.sessions() as db:
            self.assertEqual((await create_optimization(db, request, self.owner, self.catalog)).id, created_id)
