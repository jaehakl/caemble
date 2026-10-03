"""Optimization persistence and public execution boundaries; no Solver execution."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import unittest
import uuid
from copy import deepcopy
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from caemble_catalog import Catalog
from simulation.services import recording
from simulation.services.batches import list_batches
from simulation.db import CaeBatch
from optimization.db import Evaluation, StageSubmission, Optimization, Trial
from optimization.controller import reconcile_optimization
from optimization.evaluations import ensure_evaluation
from optimization.schemas import OptimizationCreateRequest
from optimization.search import advance_solver_search
from optimization import evaluation, integration
from optimization.service import (
    create_optimization, delete_optimization, list_optimizations, list_trials, require_optimization,
    resume_optimization,
)
from optimization.guards import require_unmanaged_execution, require_unreferenced_experiments, require_unreferenced_measurements
from calculation.db import Calculation, CalculationSource
from simulation.db import Experiment, Measurement
from db import make_async_db_url
from gpstation.db import Job, JobBatch
from gpstation.service.job_service import JobService
from gpstation.service.server_handlers import register_server_handler, server_handlers
from user_auth.schemas import RoleEnum, UserData
from test_calculation_database import _create_database, _database_url, _drop_database, _seed_owners, _upgrade


class OptimizationRequestTests(unittest.TestCase):
    def request(self, **overrides):
        return {"request_id": str(uuid.uuid4()), "experiment_id": 1, "source_hash": "a" * 64,
                "vars_schema": {}, "initial_vars": {}, "objective": {"calculation_id": 1}, **overrides}

    def test_invalid_limits_constraints_and_unrecognized_configuration_are_rejected(self):
        for value in ({"max_trials": 0}, {"max_parallel": True}, {"unknown": True},
                      {"constraints": [{"calculation_id": 2}]},
                      {"constraints": [{"calculation_id": 2, "minimum": 3, "maximum": 2}]},
                      {"constraints": [{"calculation_id": 2, "minimum": float("inf")}]},
                      {"axes": [{"name": "x", "min": 2, "max": 1}]}):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                OptimizationCreateRequest.model_validate(self.request(**value))


    def test_de_request_defaults_versions_and_partial_population_budget(self):
        request = OptimizationCreateRequest.model_validate(self.request(algorithm={"id": "de"}, max_trials=1))
        self.assertEqual(request.algorithm.model_dump(), {"id": "de", "version": 1, "config": {
            "population_size": 8, "mutation_factor": 0.8, "crossover_rate": 0.9, "seed": 0}})
        self.assertEqual(request.max_trials, 1)
        for algorithm in ({"id": "de", "version": 2}, {"id": "de", "version": True},
                          {"id": "de", "config": {"seed": "42"}},
                          {"id": "de", "config": {"candidates_per_round": 4}}):
            with self.subTest(algorithm=algorithm), self.assertRaises(ValidationError):
                OptimizationCreateRequest.model_validate(self.request(algorithm=algorithm))


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class OptimizationPersistenceTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        asyncio.run(_create_database(cls.database))
        try:
            _upgrade(cls.database, "head")
            cls.owner_id, cls.other_id, cls.experiment_id, _ = asyncio.run(_seed_owners(cls.database))
            cls.catalog = Catalog.open_readonly()
            entry = cls.catalog.list_experiments(limit=1)[0][0]
            cls.example = cls.catalog.experiment(entry["coordinate"])
        except BaseException:
            asyncio.run(_drop_database(cls.database))
            raise

    @classmethod
    def tearDownClass(cls):
        cls.catalog.close()
        asyncio.run(_drop_database(cls.database))

    async def asyncSetUp(self):
        handlers = patch.dict(server_handlers, clear=True)
        handlers.start()
        self.addCleanup(handlers.stop)
        for name, implementation in (("cae.simulation", recording), ("cae.evaluation.build", evaluation), ("cae.evaluation.calculate", evaluation)):
            register_server_handler(name, implementation, event_context=integration.event_context, on_finished=integration.on_finished)
        self.engine = create_async_engine(make_async_db_url(_database_url(self.database)))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.owner = UserData(id=self.owner_id, roles=[RoleEnum.user])
        self.other = UserData(id=self.other_id, roles=[RoleEnum.user])
        self.admin = UserData(id=self.other_id, roles=[RoleEnum.admin])
        async with self.sessions() as db:
            for model in (Optimization, Measurement, JobBatch, Job, Calculation, CalculationSource):
                await db.execute(delete(model))
            experiment = await db.get(Experiment, self.experiment_id)
            experiment.source_bundle = self.example["sourceBundle"]
            experiment.source_hash = self.example["bundleHash"]
            experiment.result_contracts = {}
            source = CalculationSource(source_code="export default () => 1", source_hash=hashlib.sha256(b"export default () => 1").hexdigest(),
                                       name="Objective", revision=1, owner_id=self.owner_id)
            db.add(source)
            await db.flush()
            calculation = Calculation(experiment_id=self.experiment_id, source_id=source.id,
                                      contract_status="ready", validated_source_revision=1,
                                      output_layout={"dtype": "float64", "shape": [], "axes": []})
            db.add(calculation)
            await db.commit()
            self.calculation_id, self.source_id = calculation.id, source.id

    async def asyncTearDown(self):
        await self.engine.dispose()

    def request(self, **overrides):
        return OptimizationCreateRequest.model_validate({"request_id": str(uuid.uuid4()), "experiment_id": self.experiment_id,
            "source_hash": self.example["bundleHash"], "vars_schema": {"x": {"shape": [2], "min": 0, "max": 10}},
            "initial_vars": {"x": [4, 5]}, "objective": {"calculation_id": self.calculation_id}, **overrides})

    async def test_create_is_idempotent_and_sources_are_owned_frozen_snapshots(self):
        request = self.request()
        async with self.sessions() as db:
            optimization = await create_optimization(db, request, self.owner, self.catalog)
            self.assertEqual(len(optimization.settings["axes"]), 2)
            legacy_payload = request.model_dump(mode="json", exclude={"algorithm", "hybrid"})
            legacy_hash = hashlib.sha256(json.dumps(legacy_payload, sort_keys=True, separators=(",", ":"),
                                                   ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()
            self.assertEqual(optimization.request_hash, legacy_hash)
            duplicate = await create_optimization(db, request, self.owner, self.catalog)
            self.assertEqual(duplicate.id, optimization.id)
            optimization_id = optimization.id
            with self.assertRaises(HTTPException) as changed:
                await create_optimization(db, request.model_copy(update={"max_trials": 3}), self.owner, self.catalog)
            self.assertEqual(changed.exception.status_code, 409)
            await db.rollback()
            source = await db.get(CalculationSource, self.source_id)
            source.source_code, source.source_hash, source.revision = "changed", hashlib.sha256(b"changed").hexdigest(), 2
            await db.commit()
            frozen = await db.get(Optimization, optimization_id)
            self.assertEqual(frozen.definition["calculations"][0]["source"], "export default () => 1")
            self.assertEqual(frozen.definition["calculations"][0]["source_revision"], 1)
            with self.assertRaises(HTTPException):
                await require_optimization(db, optimization_id, self.other)
            self.assertEqual((await require_optimization(db, optimization_id, self.admin)).id, optimization_id)
            self.assertEqual((await list_optimizations(db, self.other, experiment_id=None, limit=20, offset=0))["total"], 0)
            self.assertEqual((await list_optimizations(db, self.admin, experiment_id=None, limit=20, offset=0))["total"], 1)

    async def test_random_configuration_is_frozen_and_replayed_without_new_identity(self):
        request = self.request(algorithm={"id": "random", "config": {"seed": 42}})
        async with self.sessions() as db:
            optimization = await create_optimization(db, request, self.owner, self.catalog)
            self.assertEqual(optimization.settings["algorithm"], {"id": "random", "version": 1,
                "config": {"seed": 42, "candidates_per_round": 8}})
            identity, definition = optimization.id, optimization.definition.copy()
            again = await create_optimization(db, request, self.owner, self.catalog)
            self.assertEqual((again.id, again.definition), (identity, definition))
            changed = request.model_dump(mode="json")
            changed["algorithm"]["config"]["seed"] = 43
            with self.assertRaises(HTTPException) as rejected:
                await create_optimization(db, OptimizationCreateRequest.model_validate(changed), self.owner, self.catalog)
            self.assertEqual(rejected.exception.status_code, 409)

    async def test_de_population_and_rng_replay_after_database_reload_and_rollback(self):
        request = self.request(algorithm={"id": "de", "config": {"population_size": 4, "seed": 42}},
                               max_trials=8, max_parallel=4)

        async def submitted(db, optimization, trial, catalog):
            # Exercise durable coordination without creating external work.
            trial.state = "running"

        self.enterContext(patch("optimization.controller.submit_stage", AsyncMock(side_effect=submitted)))
        async with self.sessions() as db:
            optimization = await create_optimization(db, request, self.owner, self.catalog)
            identity = optimization.id
            self.assertEqual(optimization.settings["algorithm"], {"id": "de", "version": 1, "config": {
                "population_size": 4, "mutation_factor": 0.8, "crossover_rate": 0.9, "seed": 42}})
            self.assertEqual((await create_optimization(db, request, self.owner, self.catalog)).id, identity)
            initial, definitions, _, _ = advance_solver_search([], optimization.settings,
                                                              optimization.optimizer_state, evaluations=[])
            await reconcile_optimization(db, optimization, self.catalog)
            self.assertEqual(optimization.optimizer_state, initial)
            trials = list((await db.scalars(select(Trial).where(Trial.optimization_id == identity).order_by(Trial.ordinal))).all())
            self.assertEqual([item.variables for item in trials], [item["variables"] for item in definitions])
            await db.commit()

        async with self.sessions() as db:
            optimization = await db.get(Optimization, identity)
            self.assertEqual(optimization.optimizer_state, initial)
            await reconcile_optimization(db, optimization, self.catalog)
            self.assertEqual(optimization.optimizer_state, initial)
            trials = list((await db.scalars(select(Trial).where(Trial.optimization_id == identity).order_by(Trial.ordinal))).all())
            self.assertEqual(len(trials), 4)
            for trial in trials:
                trial.state, trial.next_stage = "succeeded", "complete"
                trial.result = {"objective": sum(value ** 2 for value in trial.variables["x"]),
                                "feasible": True, "violation": 0}
                await ensure_evaluation(db, optimization, trial)
            evaluations = list((await db.scalars(select(Evaluation).where(Evaluation.optimization_id == identity))).all())
            expected, children, _, _ = advance_solver_search(trials, optimization.settings,
                                                            optimization.optimizer_state, evaluations=evaluations)
            self.assertEqual(expected["algorithm_state"]["data"]["generation"], 1)
            self.assertEqual(len(expected["algorithm_state"]["data"]["pending"]), 4)
            await db.commit()

        for commit in (False, True):
            async with self.sessions() as db:
                optimization = await db.get(Optimization, identity)
                self.assertEqual(optimization.optimizer_state, initial)
                await reconcile_optimization(db, optimization, self.catalog)
                self.assertEqual(optimization.optimizer_state, expected)
                trials = list((await db.scalars(select(Trial).where(Trial.optimization_id == identity).order_by(Trial.ordinal))).all())
                self.assertEqual(len(trials), 8)
                self.assertEqual([item.variables for item in trials[4:]], [item["variables"] for item in children])
                if commit:
                    await db.commit()
                else:
                    await db.rollback()

        async with self.sessions() as db:
            optimization = await db.get(Optimization, identity)
            restored = deepcopy(optimization.optimizer_state)
            self.assertEqual(restored, expected)
            await reconcile_optimization(db, optimization, self.catalog)
            self.assertEqual(optimization.optimizer_state, restored)
            self.assertEqual(len(list((await db.scalars(select(Trial).where(Trial.optimization_id == identity))).all())), 8)

    async def stage(self, db, optimization):
        batch = JobBatch(user_id=self.owner_id, request_id=str(uuid.uuid4()), request_hash="stage", total=1,
                         created_count=1, uploaded_count=1, state="queued", generation_stopped=True)
        db.add(batch)
        await db.flush()
        db.add(CaeBatch(batch_id=batch.id, experiment_id=self.experiment_id, spec={"mode": "candidate"}))
        job = Job(user_id=self.owner_id, batch_id=batch.id, item_index=1, handler_type="cae.evaluation.build",
                  slave_app_id="evaluation", job_mode="websocket", state="queued", input={})
        db.add(job)
        await db.flush()
        measurement = Measurement(user_id=self.owner_id, experiment_id=self.experiment_id, vars={"x": [4, 5]}, material_snapshot={})
        db.add(measurement)
        await db.flush()
        trial = Trial(optimization_id=optimization.id, ordinal=1, round_index=0, variables=measurement.vars, fingerprint="candidate",
                      measurement_id=measurement.id, state="running")
        db.add(trial)
        await db.flush()
        db.add(StageSubmission(trial_id=trial.id, stage="build", generation=1, batch_id=batch.id, job_id=job.id))
        await db.commit()
        return trial, job, batch

    async def test_children_are_filtered_before_pagination_and_reject_public_mutation(self):
        async with self.sessions() as db:
            optimization = await create_optimization(db, self.request(), self.owner, self.catalog)
            trial, job, batch = await self.stage(db, optimization)
            self.assertEqual(len(await JobService.list_job_summaries(db, user_id=self.owner_id, active_only=False, limit=1)), 1)
            optimization_child = select(StageSubmission.id).where(StageSubmission.job_id == Job.id).exists()
            self.assertEqual(await JobService.list_job_summaries(db, user_id=None, active_only=False, limit=1, predicate=~optimization_child), [])
            self.assertEqual((await list_batches(db, self.owner_id, experiment_id=None, limit=1, offset=0, exclude_optimizations=True))["total"], 0)
            for identity in ({"job_id": job.id}, {"batch_id": batch.id}):
                with self.assertRaises(HTTPException) as caught:
                    await require_unmanaged_execution(db, **identity, user_id=self.owner_id)
                self.assertEqual(caught.exception.detail["optimization_id"], optimization.id)
            page = await list_trials(db, optimization, limit=1, offset=0)
            self.assertEqual(page["items"][0]["stages"][0]["job"]["id"], job.id)
            self.assertEqual((await list_trials(db, optimization, limit=1, offset=1))["items"], [])
            item = (await list_optimizations(db, self.owner, experiment_id=None, limit=1, offset=0))["items"][0]
            self.assertEqual(item["executions_active"], 1)
            self.assertFalse(item["cleanup_pending"])
            self.assertFalse(item["manual_retry_pending"])

    async def test_retained_history_protects_inputs_and_deletion_preserves_measurements(self):
        async with self.sessions() as db:
            optimization = await create_optimization(db, self.request(), self.owner, self.catalog)
            trial, job, batch = await self.stage(db, optimization)
            for operation in (require_unreferenced_experiments(db, [self.experiment_id]),
                              require_unreferenced_measurements(db, [trial.measurement_id])):
                with self.assertRaises(HTTPException):
                    await operation
            optimization.state = "paused"
            with self.assertRaises(HTTPException):
                await delete_optimization(db, optimization)
            job.state = "cancelled"
            await db.flush()
            await delete_optimization(db, optimization)
            await db.commit()
            self.assertIsNotNone(await db.get(Measurement, trial.measurement_id))
            self.assertIsNotNone(await db.get(Job, job.id))
            self.assertIsNotNone(await db.get(JobBatch, batch.id))
            self.assertEqual(list((await db.scalars(select(Trial))).all()), [])

    async def test_resume_rejects_unresolved_failures_and_active_manual_retry(self):
        async with self.sessions() as db:
            optimization = await create_optimization(db, self.request(), self.owner, self.catalog)
            trial, job, _ = await self.stage(db, optimization)
            optimization.state, trial.state = "paused", "failed"
            await db.flush()
            with self.assertRaises(HTTPException):
                await resume_optimization(db, optimization)
            trial.state, trial.manual_retry_requested = "running", True
            await db.flush()
            with self.assertRaises(HTTPException):
                await resume_optimization(db, optimization)
            trial.state, trial.manual_retry_requested = "succeeded", False
            await db.flush()
            with self.assertRaises(HTTPException):
                await resume_optimization(db, optimization)
            job.state = "succeeded"
            await db.flush()
            await resume_optimization(db, optimization)
            self.assertEqual(optimization.state, "running")

    async def test_saved_calculation_can_validate_on_first_trial_and_fixed_axis_uses_schema_bounds(self):
        async with self.sessions() as db:
            calculation = await db.get(Calculation, self.calculation_id)
            calculation.contract_status, calculation.output_layout, calculation.validated_source_revision = "needs_preflight", None, None
            await db.commit()
            optimization = await create_optimization(db, self.request(axes=[{"name": "x", "indices": [0], "fixed": True}]), self.owner, self.catalog)
            self.assertIsNone(optimization.definition["calculations"][0]["output_layout"])
            self.assertTrue(optimization.settings["axes"][0]["fixed"])
            self.assertEqual((optimization.settings["axes"][0]["min"], optimization.settings["axes"][0]["max"]), (0, 10))

    async def test_concurrent_create_reuses_one_optimization_and_rejects_nonfinite_nested_vars(self):
        request = self.request()

        async def create():
            async with self.sessions() as db:
                return (await create_optimization(db, request, self.owner, self.catalog)).id

        first, second = await asyncio.gather(create(), create())
        self.assertEqual(first, second)
        async with self.sessions() as db:
            with self.assertRaises(HTTPException) as caught:
                await create_optimization(db, self.request(initial_vars={"x": [float("nan"), 5]}), self.owner, self.catalog)
            self.assertEqual(caught.exception.status_code, 422)


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class OptimizationMigrationTests(unittest.TestCase):
    def test_optimization_tables_upgrade_from_revision_19_without_replacing_experiments(self):
        from alembic import command
        from alembic.config import Config
        from settings import settings
        from test_calculation_database import API_DIR, ORIGINAL_DB_URL, _check, _table_names

        database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        asyncio.run(_create_database(database))
        try:
            _upgrade(database, "000000000019")
            _, _, experiment_id, _ = asyncio.run(_seed_owners(database))
            self.assertNotIn("cae_optimizations", asyncio.run(_table_names(database)))
            _upgrade(database, "head")
            self.assertTrue({"cae_optimizations", "cae_trials", "cae_stage_submissions"}.issubset(asyncio.run(_table_names(database))))

            async def retained():
                engine = create_async_engine(make_async_db_url(_database_url(database)))
                try:
                    async with async_sessionmaker(engine)() as db:
                        return (await db.get(Experiment, experiment_id)).source_hash
                finally:
                    await engine.dispose()

            self.assertEqual(asyncio.run(retained()), "hash-calc-owner")
            _check(database)
        finally:
            asyncio.run(_drop_database(database))
