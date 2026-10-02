"""Real kNN publication and Hybrid model adoption on disposable PostgreSQL.

The tensor fixture is native BoxGrid data. Training, saved-file validation and
Prediction loading run in the actual Predictor; no Solver is executed.
"""
from copy import deepcopy
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import func, select

from gpstation.db import Job, Launcher
from gpstation.service.batches import finish_job, serialize_events
from optimization.algorithm import prepare_axes, variables_fingerprint
from optimization.controller import cancel_optimization
from optimization.db import Evaluation, Optimization, OptimizationModelPin, Trial
from optimization.evaluations import ensure_evaluation
from optimization.hybrid import reconcile_hybrid
from optimization.model_updates import bind_round, finish_updates, model_state, request_update, sync_pins
from optimization.schemas import OptimizationModelUpdateRequest
from optimization.service import resume_optimization
from prediction import training
from prediction.db import Dataset, DatasetRevision, ModelRevision, Operation, Replica, TrainingRun
from prediction.operations import assert_copy_idle
from simulation.db import Experiment, ExperimentRecord, Measurement, RecordedData
import test_prediction_assets as assets
import test_prediction_training as training_fixtures


def predictor_modules():
    root = Path(__file__).resolve().parents[2] / "slaves" / "cae_prediction"
    if "predictor" not in sys.modules:
        spec = importlib.util.spec_from_file_location("predictor", root / "app" / "__init__.py",
            submodule_search_locations=[str(root / "app")])
        package = importlib.util.module_from_spec(spec)
        sys.modules["predictor"] = package
        spec.loader.exec_module(package)
    fixture_spec = importlib.util.spec_from_file_location("optimization_predictor_fixtures", root / "tests" / "fixtures.py")
    fixtures = importlib.util.module_from_spec(fixture_spec)
    fixture_spec.loader.exec_module(fixtures)
    from predictor.models import ModelBundle
    from predictor.runtime import PredictorRuntime
    return PredictorRuntime, ModelBundle, fixtures


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class OptimizationModelUpdateTests(unittest.IsolatedAsyncioTestCase):
    setUpClass = classmethod(assets.PredictionAssetsTests.setUpClass.__func__)
    tearDownClass = classmethod(assets.PredictionAssetsTests.tearDownClass.__func__)
    model_request = assets.PredictionAssetsTests.model_request
    reserve = training_fixtures.PredictionTrainingTests.reserve

    async def asyncSetUp(self):
        await training_fixtures.PredictionTrainingTests.asyncSetUp(self)
        self.Runtime, self.Bundle, self.predictor_fixtures = predictor_modules()
        self.temporary = tempfile.TemporaryDirectory(prefix="optimization-knn-")
        self.root = Path(self.temporary.name)
        (self.root / "storage-id").write_text(self.storage_id, encoding="utf-8")
        self.worker = self.Runtime(self.root, self.owner, self.launcher_id, "http://127.0.0.1:8000", 128 * 1024 ** 2)
        native = self.predictor_fixtures.dataset()
        self.native_schema = native["recorded"][0]["data_schema"]
        self.native_data = native["recorded"][0]["data"]
        self.catalog = SimpleNamespace(meta=lambda: {"catalogRevision": "test-catalog"})
        async with self.sessions() as db:
            record = await db.get(ExperimentRecord, self.record_id)
            record.data_schema, record.tensor_order = self.native_schema, 7
            recorded = await db.scalar(select(RecordedData).where(RecordedData.measurement_id == self.measurement_id))
            recorded.data = self.tensor(20)
            launcher = await db.get(Launcher, self.launcher_id)
            launcher.slave_app_ids = ["predictor", "predictor-training", "evaluation"]
            launcher.job_modes = {"predictor": "webrtc", "predictor-training": "websocket", "evaluation": "websocket"}
            launcher.resources = {"cpu_total": 4, "ram_budget_bytes": 2 ** 30,
                "defaults": {name: {"startup_ram_bytes": 2 ** 20} for name in launcher.slave_app_ids}}
            await db.commit()
        await self.record(0, 0)
        await self.record(1, 10)

    async def asyncTearDown(self):
        self.temporary.cleanup()
        await training_fixtures.PredictionTrainingTests.asyncTearDown(self)

    def tensor(self, value):
        tensor = deepcopy(self.native_data)
        cell = value
        for _ in range(7):
            cell = [cell]
        tensor["storage"]["value"] = cell
        return tensor

    def selection(self, **changes):
        rules = [{"label": "temperature", "target": [], "methodId": "fixture", "parameters": {},
            "result": self.native_schema}]
        return assets.PredictionAssetsTests.selection(self, rules=rules, **changes)

    async def record(self, width, value):
        async with self.sessions() as db:
            measurement = Measurement(user_id=self.owner, experiment_id=self.experiment_id,
                vars={"width": width}, material_snapshot={}, recorded_at=training.utcnow())
            db.add(measurement)
            await db.flush()
            db.add(RecordedData(user_id=self.owner, measurement_id=measurement.id,
                experiment_record_id=self.record_id, data=self.tensor(value)))
            await db.commit()
            return measurement.id

    async def train_and_publish(self, operation_id):
        async with self.sessions() as db:
            operation = await db.get(Operation, operation_id)
            run = await db.get(TrainingRun, operation_id)
            if run.job_id is None:
                await training.submit(db, operation_id, self.owner)
            job = await db.get(Job, run.job_id)
            job.launcher_id, job.state = self.launcher_id, "running"
            await db.commit()
            source = await db.get(DatasetRevision, (run.dataset_id, run.dataset_revision))
            dataset = await db.get(Dataset, run.dataset_id)
            manifest = {**source.payload, "name": dataset.name}
            reference = self.predictor_fixtures.stage(self.worker, manifest)
            spec = deepcopy(job.input)
            grant = training.pin_grant(operation, run)
            _, _, scope = await training.authority(db, operation_id, "Bearer " + grant["token"])
            if spec.get("update") is not None:
                with patch.object(self.worker.training, "authority", return_value=scope), \
                        patch.object(self.worker.training, "_ack_pin", return_value={"pinId": run.pin_id}):
                    self.worker.training.run("training.pin", {"grant": grant})
                await training.acknowledge_pin(db, operation_id, "Bearer " + grant["token"], run.pin_id)
            result = self.worker.training.train(spec, lambda: reference)
            # Load in a separate runtime to exercise the saved bundle, rather than
            # relying on an in-memory result from training.
            reader = self.Runtime(self.root, self.owner, self.launcher_id, "http://127.0.0.1:8000", 128 * 1024 ** 2)
            bundle, artifact = self.Bundle.load(reader.store, spec["model"]["modelId"],
                spec["model"]["revision"], reader._model_context())
            try:
                prediction = bundle.predict({"direction": "forward", "vars": {"width": 3}}, reader._model_context())
            finally:
                bundle.close()
            self.assertEqual(artifact["manifestChecksum"], result["artifact"]["manifestChecksum"])
            await serialize_events(db)
            receipt = await training.complete_job(db, job, result)
            await finish_job(db, job, "succeeded", result=receipt)
            job.cleaned_at = training.utcnow()
            await db.commit()
            return result["artifact"], prediction

    async def optimization(self):
        async with self.sessions() as db:
            dataset, model = await self.reserve(db)
        await self.train_and_publish(model["operation_id"])
        async with self.sessions() as db:
            revision = await db.get(ModelRevision, (model["id"], 1))
            replica = await db.scalar(select(Replica).where(Replica.model_id == model["id"], Replica.revision == 1))
            experiment = await db.get(Experiment, self.experiment_id)
            source = {"model_id": model["id"], "model_revision": 1, "replica_id": replica.id,
                "storage_id": self.storage_id, "launcher_id": self.launcher_id,
                "checksum": revision.artifact["manifest_sha256"], "dataset_id": dataset["id"], "dataset_revision": 1,
                "dataset_fingerprint": revision.dataset_fingerprint, "model_definition": revision.definition,
                "source_contracts": revision.source_contracts, "max_solver_runs": 5,
                "resources": {name: {"cpu_cores": 1, "startup_ram_bytes": 2 ** 20, "gpu_count": 0}
                    for name in ("evaluation", "predictor")}}
            settings = {"max_trials": 5, "max_parallel": 2, "initial_vars": {"width": 2},
                "initial_step": 0.25, "min_step": 0.01, "objective": {"direction": "minimize"},
                "constraints": [], "hybrid": source,
                "axes": prepare_axes(revision.source_contracts["varsSchema"], {"width": 2})}
            optimization = Optimization(user_id=self.owner, experiment_id=self.experiment_id, name="Online kNN",
                request_id=str(uuid4()), request_hash="fixture", state="running", settings=settings,
                definition={"hash": "optimization-definition", "catalog_revision": "test-catalog", "catalog": {},
                    "source_bundle": experiment.source_bundle, "source_hash": experiment.source_hash,
                    "result_contracts": {}, "calculations": [], "hybrid": source},
                optimizer_state={"round_index": 0, "round_ordinals": [1], "step": 0.25})
            db.add(optimization)
            await db.flush()
            trial = Trial(optimization_id=optimization.id, ordinal=1, round_index=0, variables={"width": 2},
                fingerprint=variables_fingerprint({"width": 2}), state="succeeded", next_stage="complete")
            db.add(trial)
            await db.flush()
            await bind_round(db, optimization, 0)
            for kind in ("prediction", "solver"):
                item = await ensure_evaluation(db, optimization, trial, kind)
                item.state, item.next_stage = "succeeded", "complete"
                item.result = {"objective": 20, "feasible": True, "violation": 0, "constraints": []}
            optimization.optimizer_state = {**optimization.optimizer_state, "selection": [trial.id]}
            await db.commit()
            return optimization.id

    async def request(self, optimization_id, request_id=None, update_mode="rebuild"):
        body = OptimizationModelUpdateRequest(request_id=request_id or uuid4(), update_mode=update_mode)
        async with self.sessions() as db:
            await serialize_events(db)
            optimization = await db.get(Optimization, optimization_id)
            await request_update(db, optimization, body)
            await db.commit()
            return model_state(optimization)["updates"][-1]

    async def advance(self, optimization_id):
        async with self.sessions() as db:
            await serialize_events(db)
            optimization = await db.get(Optimization, optimization_id)
            await reconcile_hybrid(db, optimization, self.catalog)
            await db.commit()
            return model_state(optimization)

    async def test_real_knn_update_waits_then_adopts_at_next_round(self):
        optimization_id = await self.optimization()
        measurement_id = await self.record(3, 90)
        request_id = uuid4()
        update = await self.request(optimization_id, request_id)
        self.assertEqual(await self.request(optimization_id, request_id), update)
        alias_id = uuid4()
        duplicate = await self.request(optimization_id, alias_id)
        self.assertEqual(duplicate["operation_id"], update["operation_id"])
        self.assertEqual(duplicate["revision"], update["revision"])
        self.assertIn(str(alias_id), duplicate["request_ids"])
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(ModelRevision)
                .where(ModelRevision.model_id == update["model_id"])), 2)
            revision = await db.get(ModelRevision, (update["model_id"], 2))
            target = await db.get(DatasetRevision, (revision.dataset_id, revision.dataset_revision))
            self.assertEqual(target.summary["sample_count"], 4)
            operation = await db.get(Operation, update["operation_id"])
            self.assertIn(measurement_id, operation.details["update"]["changeSet"]["added"])
        waiting = await self.advance(optimization_id)
        self.assertTrue(waiting["waiting"])
        self.assertEqual(waiting["active_model"]["model_revision"], 1)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Trial)
                .where(Trial.optimization_id == optimization_id)), 1)
        artifact, prediction = await self.train_and_publish(update["operation_id"])
        self.assertEqual(artifact["validation"]["manifestChecksum"], artifact["manifestChecksum"])
        self.assertEqual(prediction["provenance"]["modelRevision"], 2)
        self.assertEqual(prediction["output"][0]["values"], [90])
        state = await self.advance(optimization_id)
        self.assertFalse(state["waiting"])
        self.assertEqual(state["initial_model"]["model_revision"], 1)
        self.assertEqual(state["active_model"]["model_revision"], 2)
        self.assertEqual(state["round_model"]["model_revision"], 2)
        self.assertEqual(state["updates"][0]["adopted_round"], 1)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            self.assertEqual(optimization.definition["hybrid"]["model_revision"], 1)
            evaluations = (await db.scalars(select(Evaluation).where(Evaluation.kind == "prediction",
                Evaluation.optimization_id == optimization_id))).all()
            self.assertEqual(sorted(item.source["model_revision"] for item in evaluations), [1, 2, 2])
            self.assertEqual(optimization.optimizer_state["round_sources"]["0"]["model_revision"], 1)
            self.assertEqual(optimization.optimizer_state["round_sources"]["1"]["model_revision"], 2)

    async def test_unsupported_mode_rolls_back_snapshot_reservation_and_receipt(self):
        optimization_id = await self.optimization()
        await self.record(3, 90)
        with self.assertRaises(HTTPException) as rejected:
            await self.request(optimization_id, update_mode="warm_start")
        self.assertEqual(rejected.exception.status_code, 422)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            state = model_state(optimization)
            self.assertEqual(state["updates"], [])
            dataset = await db.get(Dataset, state["active_model"]["dataset_id"])
            self.assertEqual(dataset.current_revision, 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(DatasetRevision)
                .where(DatasetRevision.dataset_id == dataset.id)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(ModelRevision)
                .where(ModelRevision.model_id == state["active_model"]["model_id"])), 1)
        accepted = await self.request(optimization_id)
        self.assertEqual(accepted["revision"], 2)

    async def test_failed_update_keeps_initial_model_and_frozen_retry_inputs(self):
        optimization_id = await self.optimization()
        await self.record(3, 90)
        update = await self.request(optimization_id)
        await self.advance(optimization_id)
        async with self.sessions() as db:
            await serialize_events(db)
            run = await db.get(TrainingRun, update["operation_id"])
            job = await db.get(Job, run.job_id)
            await finish_job(db, job, "failed", "Training disconnected")
            job.cleaned_at = training.utcnow()
            await db.commit()
        state = await self.advance(optimization_id)
        self.assertEqual(state["active_model"]["model_revision"], 1)
        self.assertEqual(state["round_model"]["model_revision"], 1)
        self.assertIsNone(state["pending_model"])
        self.assertEqual(state["updates"][0]["state"], "failed")
        async with self.sessions() as db:
            run = await db.get(TrainingRun, update["operation_id"])
            source = await db.get(DatasetRevision, (run.dataset_id, run.dataset_revision))
            self.assertIsNotNone(source.payload)
            self.assertEqual(source.summary["sample_count"], 4)

    async def test_shared_optimization_pin_holds_generated_copy_until_release(self):
        optimization_id = await self.optimization()
        await self.record(3, 90)
        update = await self.request(optimization_id)
        await self.advance(optimization_id)
        await self.train_and_publish(update["operation_id"])
        state = await self.advance(optimization_id)
        async with self.sessions() as db:
            original = await db.get(Optimization, optimization_id)
            shared = Optimization(user_id=self.owner, experiment_id=self.experiment_id, name="Shared model",
                request_id=str(uuid4()), request_hash="shared", state="paused", settings=original.settings,
                definition={**original.definition, "hybrid": state["active_model"]}, optimizer_state={})
            db.add(shared)
            await db.flush()
            await sync_pins(db, shared)
            copy = await db.get(Replica, state["active_model"]["replica_id"])
            original.state = "completed"
            await finish_updates(db, original)
            with self.assertRaises(HTTPException) as retained:
                await assert_copy_idle(db, copy)
            self.assertEqual(retained.exception.detail["optimization_id"], shared.id)
            self.assertEqual(await db.scalar(select(func.count()).select_from(OptimizationModelPin)
                .where(OptimizationModelPin.optimization_id == shared.id)), 2)
            shared.state = "completed"
            await finish_updates(db, shared)
            await assert_copy_idle(db, copy)
            revision = await db.get(ModelRevision, (update["model_id"], 2))
            self.assertEqual(revision.state, "ready")
            self.assertEqual(revision.preparation["online_origin"]["optimization_id"], optimization_id)
            await db.commit()

    async def test_paused_update_is_ready_until_resume_binds_next_round(self):
        optimization_id = await self.optimization()
        await self.record(3, 90)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            optimization.state = "paused"
            await db.commit()
        update = await self.request(optimization_id)
        await self.advance(optimization_id)
        await self.train_and_publish(update["operation_id"])
        state = await self.advance(optimization_id)
        self.assertEqual(state["active_model"]["model_revision"], 1)
        self.assertEqual(state["pending_model"]["model_revision"], 2)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            await resume_optimization(db, optimization)
            await db.commit()
        state = await self.advance(optimization_id)
        self.assertEqual(state["active_model"]["model_revision"], 2)
        self.assertEqual(state["updates"][0]["adopted_round"], 1)

    async def test_stop_waits_for_training_cleanup_and_resume_keeps_old_model(self):
        optimization_id = await self.optimization()
        await self.record(3, 90)
        update = await self.request(optimization_id)
        await self.advance(optimization_id)
        async with self.sessions() as db:
            await serialize_events(db)
            run = await db.get(TrainingRun, update["operation_id"])
            job = await db.get(Job, run.job_id)
            job.launcher_id, job.state = self.launcher_id, "running"
            optimization = await db.get(Optimization, optimization_id)
            await cancel_optimization(db, optimization)
            await db.commit()
        await self.advance(optimization_id)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            self.assertEqual(optimization.state, "pausing")
            with self.assertRaises(HTTPException):
                await resume_optimization(db, optimization)
            run = await db.get(TrainingRun, update["operation_id"])
            job = await db.get(Job, run.job_id)
            self.assertEqual(job.state, "cancelled")
            job.cleaned_at = training.utcnow()
            await db.commit()
        state = await self.advance(optimization_id)
        self.assertEqual(state["updates"][0]["state"], "cancelled")
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            self.assertEqual(optimization.state, "paused")
            await resume_optimization(db, optimization)
            await db.commit()
        state = await self.advance(optimization_id)
        self.assertEqual(state["active_model"]["model_revision"], 1)

    async def test_completed_search_tracks_explicit_retry_without_adoption(self):
        optimization_id = await self.optimization()
        await self.record(3, 90)
        update = await self.request(optimization_id)
        await self.advance(optimization_id)
        async with self.sessions() as db:
            await serialize_events(db)
            run = await db.get(TrainingRun, update["operation_id"])
            job = await db.get(Job, run.job_id)
            await finish_job(db, job, "failed", "Initial training failed")
            job.cleaned_at = training.utcnow()
            optimization = await db.get(Optimization, optimization_id)
            optimization.state = "completed"
            await finish_updates(db, optimization)
            await db.commit()
            nonce = str(uuid4())
            await training.preflight(db, update["operation_id"], nonce, self.owner)
            await training.submit(db, update["operation_id"], self.owner, retry_request_id=nonce)
        state = await self.advance(optimization_id)
        self.assertEqual(state["updates"][0]["state"], "queued")
        await self.train_and_publish(update["operation_id"])
        state = await self.advance(optimization_id)
        self.assertEqual(state["updates"][0]["state"], "completed_unadopted")
        self.assertEqual(state["active_model"]["model_revision"], 1)
        self.assertIsNone(state["pending_model"])
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            self.assertEqual(optimization.state, "completed")
            self.assertEqual(await db.scalar(select(func.count()).select_from(Trial)
                .where(Trial.optimization_id == optimization_id)), 1)
            self.assertEqual(await db.scalar(select(func.count()).select_from(OptimizationModelPin)
                .where(OptimizationModelPin.optimization_id == optimization_id)), 0)
