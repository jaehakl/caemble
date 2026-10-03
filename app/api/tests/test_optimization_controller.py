"""Real DB transitions with inexpensive stage results, without product Solvers."""

import asyncio
import os
import unittest
import uuid
from unittest.mock import patch

import test_optimization_api as persistence_fixture

from simulation.services import recording
from optimization import evaluation, integration
from optimization.controller import cancel_optimization, reconcile_optimization, reconcile_once, request_retry
from optimization.db import StageSubmission, Optimization, Trial
from optimization.service import create_optimization, list_trials, resume_optimization, optimization_detail
from optimization.submissions import submit_stage
from simulation.db import Measurement
from gpstation.db import Job, JobBatch, JobEvent, JobRecord, Launcher
from gpstation.service.batches import fail_server_jobs, finish_job, serialize_events
from gpstation.service.execution import execution_identity
from gpstation.service.state import utcnow
from gpstation.service.worker_connection import worker_cleaned
from simulation.services.material_snapshot import material_vars_hash
from simulation.services.measurements import get_recorded_data
from sqlalchemy import func, select


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class OptimizationControllerTests(unittest.IsolatedAsyncioTestCase):
    setUpClass = classmethod(persistence_fixture.OptimizationPersistenceTests.setUpClass.__func__)
    tearDownClass = classmethod(persistence_fixture.OptimizationPersistenceTests.tearDownClass.__func__)
    asyncSetUp = persistence_fixture.OptimizationPersistenceTests.asyncSetUp
    asyncTearDown = persistence_fixture.OptimizationPersistenceTests.asyncTearDown
    request = persistence_fixture.OptimizationPersistenceTests.request

    async def create(self, **overrides):
        async with self.sessions() as db:
            optimization = await create_optimization(db, self.request(**overrides), self.owner, self.catalog)
            return optimization.id

    async def advance(self, optimization_id):
        async with self.sessions() as db:
            await serialize_events(db)
            optimization = await db.scalar(select(Optimization).where(Optimization.id == optimization_id).with_for_update())
            await reconcile_optimization(db, optimization, self.catalog)
            await db.commit()

    async def jobs(self, optimization_id):
        async with self.sessions() as db:
            return list((await db.scalars(select(Job).join(StageSubmission, StageSubmission.job_id == Job.id)
                                         .join(Trial, Trial.id == StageSubmission.trial_id)
                                         .where(Trial.optimization_id == optimization_id).order_by(Job.created_at))).all())

    async def complete(self, job_id, *, failure=None):
        async with self.sessions() as db:
            await serialize_events(db)
            job = await db.get(Job, job_id)
            if failure:
                await finish_job(db, job, "failed", failure)
                await db.commit()
                return
            optimization = await db.get(Optimization, job.artifact_metadata["optimization_id"])
            trial = await db.get(Trial, job.artifact_metadata["trial_id"])
            if job.handler_type == "cae.simulation":
                result = await recording.complete_job(db, job, {"recordSequences": [], "visualizationSequences": []})
            else:
                if job.input["stage"] == "build":
                    value = {"input": {"measurement": {"kind": "measurement", "experiment": {
                        "sourceHash": optimization.definition["source_hash"], "variables": trial.variables,
                        "varsSchema": optimization.definition["vars_schema"], "scene": {}, "taskScenes": {},
                        "simulationProgram": {"pythonSource": optimization.definition["source_bundle"]["files"]["simulate.py"],
                                              "tasks": {}, "recordedData": {}, "resultContracts": {}}},
                        "materialSnapshot": {"materials": {}}, "taskMaterialSnapshots": {}, "modelDefinitions": [],
                        "materialSelections": {}, "varsHash": material_vars_hash(trial.variables)}}}
                else:
                    value = {"measurement_id": trial.measurement_id, "calculations": [{
                        "key": "objective", "source_hash": optimization.definition["calculations"][0]["source_hash"],
                        "value": sum(trial.variables["x"]),
                    }]}
                packet = {"sequence": 1, "name": job.input["stage"], "value": value}
                await evaluation.stage_record(db, job, packet, [])
                await db.flush()
                result = await evaluation.complete_job(db, job, {"recordSequences": [1],
                    "definition_hash": optimization.definition["hash"], "runtime_id": "test-runtime"})
            self.assertTrue(await finish_job(db, job, "succeeded", result=result))
            self.assertFalse(await finish_job(db, job, "succeeded", result=result))
            await db.commit()

    async def test_concurrent_reconciliation_build_solve_calculate_and_budget(self):
        await self.verify_concurrent_search()

    async def test_random_concurrent_reconciliation_and_duplicate_completion(self):
        await self.verify_concurrent_search(algorithm={"id": "random", "config": {"seed": 42}})

    async def test_unsupported_saved_version_pauses_before_creating_jobs(self):
        optimization_id = await self.create(algorithm={"id": "random"})
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            optimization.optimizer_state = {"search_version": 2, "runtime_id": "retained"}
            await db.commit()
        with patch("optimization.controller.SessionLocal", self.sessions):
            await reconcile_once(self.catalog)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            self.assertEqual(optimization.state, "paused")
            self.assertIn("Unsupported Optimization search state version", optimization.pause_reason)
            self.assertEqual(optimization.optimizer_state, {"search_version": 2, "runtime_id": "retained"})
        self.assertEqual(await self.jobs(optimization_id), [])

    async def verify_concurrent_search(self, **settings):
        optimization_id = await self.create(max_trials=3, **settings)
        await asyncio.gather(self.advance(optimization_id), self.advance(optimization_id))
        self.assertEqual(len(await self.jobs(optimization_id)), 1)
        for _ in range(12):
            for job in await self.jobs(optimization_id):
                if job.state == "queued":
                    await self.complete(job.id)
            await asyncio.gather(self.advance(optimization_id), self.advance(optimization_id))
            async with self.sessions() as db:
                optimization = await db.get(Optimization, optimization_id)
                if optimization.state == "completed":
                    break
        self.assertEqual(optimization.state, "completed")
        jobs = await self.jobs(optimization_id)
        self.assertEqual(len(jobs), 9)
        self.assertEqual(len({job.batch_id for job in jobs}), 9)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Measurement)), 3)
            self.assertIsNotNone(optimization.best_trial_id)
            events = list((await db.scalars(select(JobEvent).where(JobEvent.batch_id.in_([job.batch_id for job in jobs])))).all())
            self.assertTrue(all(event.payload.get("optimization_id") == optimization_id for event in events))

    async def test_calculation_failure_retry_reuses_solver_and_preserves_old_batch(self):
        optimization_id = await self.create(max_trials=1)
        await self.advance(optimization_id)
        for _ in range(2):
            current = [job for job in await self.jobs(optimization_id) if job.state == "queued"][0]
            await self.complete(current.id)
            await self.advance(optimization_id)
        failed = [job for job in await self.jobs(optimization_id) if job.state == "queued"][0]
        await self.complete(failed.id, failure="calculation failed")
        await self.advance(optimization_id)
        retry_id = str(uuid.uuid4())
        async with self.sessions() as db:
            await serialize_events(db)
            optimization = await db.get(Optimization, optimization_id)
            trial = await db.scalar(select(Trial).where(Trial.optimization_id == optimization_id))
            self.assertEqual((optimization.state, trial.next_stage), ("paused", "calculate"))
            measurement_id = trial.measurement_id
            await request_retry(db, optimization, trial, retry_id)
            await request_retry(db, optimization, trial, retry_id)
            await db.commit()
        await self.advance(optimization_id)
        retried = [job for job in await self.jobs(optimization_id) if job.state == "queued"][0]
        self.assertNotEqual(retried.batch_id, failed.batch_id)
        await self.complete(retried.id)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            trial = await db.scalar(select(Trial).where(Trial.optimization_id == optimization_id))
            self.assertEqual((optimization.state, trial.state, trial.measurement_id), ("paused", "succeeded", measurement_id))
            original = await db.get(JobBatch, failed.batch_id)
            self.assertEqual((original.state, original.failed), ("completed", 1))
            await resume_optimization(db, optimization)
            await db.commit()
        await self.advance(optimization_id)
        self.assertEqual(sum(job.handler_type == "cae.simulation" for job in await self.jobs(optimization_id)), 1)

    async def test_cleanup_retry_unblocks_next_stage_only_after_matching_receipt(self):
        optimization_id = await self.create(max_trials=1)
        await self.advance(optimization_id)
        first = (await self.jobs(optimization_id))[0]
        async with self.sessions() as db:
            launcher = Launcher(user_id=self.owner.id, launcher_name="cleanup fixture", status="busy",
                                connected_at=utcnow(), last_heartbeat_at=utcnow())
            db.add(launcher)
            await db.flush()
            job = await db.get(Job, first.id)
            job.launcher_id, job.boot_id = launcher.id, "fixture-boot"
            job.instance_id, job.reservation_id = "fixture-instance", "fixture-reservation"
            job.state = "running"
            identity = execution_identity(job)
            await db.commit()
        await self.complete(first.id)
        async with self.sessions() as db:
            job = await db.get(Job, first.id)
            job.cleanup_state = "cleanup_failed"
            await db.commit()
        await self.advance(optimization_id)
        self.assertEqual(len(await self.jobs(optimization_id)), 1)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            self.assertTrue((await optimization_detail(db, optimization))["cleanup_pending"])
            self.assertFalse(await worker_cleaned(db, identity={**identity, "reservation_id": "stale"}, user_id=self.owner.id))
        await self.advance(optimization_id)
        self.assertEqual(len(await self.jobs(optimization_id)), 1)
        async with self.sessions() as db:
            self.assertTrue(await worker_cleaned(db, identity=identity, user_id=self.owner.id))
            self.assertTrue(await worker_cleaned(db, identity=identity, user_id=self.owner.id))
            optimization = await db.get(Optimization, optimization_id)
            self.assertFalse((await optimization_detail(db, optimization))["cleanup_pending"])
            cleaned_events = await db.scalar(select(func.count()).select_from(JobEvent).where(
                JobEvent.job_id == first.id, JobEvent.type == "job.cleaned"))
            self.assertEqual(cleaned_events, 1)
        await self.advance(optimization_id)
        await self.advance(optimization_id)
        jobs = await self.jobs(optimization_id)
        self.assertEqual(len(jobs), 2)
        self.assertEqual(jobs[1].handler_type, "cae.simulation")
        self.assertNotEqual(jobs[1].id, first.id)

    async def test_stop_resume_and_first_failure_cancel_queued_siblings(self):
        await self.verify_stop_resume()

    async def test_random_stop_resume_and_first_failure_cancel_queued_siblings(self):
        await self.verify_stop_resume(algorithm={"id": "random", "config": {"seed": 42, "candidates_per_round": 2}})

    async def verify_stop_resume(self, **settings):
        optimization_id = await self.create(max_trials=5, **settings)
        await self.advance(optimization_id)
        first = (await self.jobs(optimization_id))[0]
        async with self.sessions() as db:
            await serialize_events(db)
            optimization = await db.get(Optimization, optimization_id)
            await cancel_optimization(db, optimization)
            await db.commit()
        await self.advance(optimization_id)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            self.assertEqual(optimization.state, "paused")
            await resume_optimization(db, optimization)
            await db.commit()
        for _ in range(3):
            await self.advance(optimization_id)
            queued = [job for job in await self.jobs(optimization_id) if job.state == "queued"]
            self.assertEqual(len(queued), 1)
            await self.complete(queued[0].id)
        await self.advance(optimization_id)
        queued = [job for job in await self.jobs(optimization_id) if job.state == "queued"]
        self.assertEqual(len(queued), 2)
        await self.complete(queued[0].id, failure="build failed")
        async with self.sessions() as db:
            self.assertEqual((await db.get(Job, queued[1].id)).state, "cancelled")
            self.assertEqual((await db.get(Job, first.id)).state, "cancelled")
            self.assertEqual((await db.get(Optimization, optimization_id)).state, "pausing")
            terminal_events = list((await db.scalars(select(JobEvent).where(
                JobEvent.batch_id.in_([job.batch_id for job in queued]),
                JobEvent.type.in_(["job.failed", "job.cancelled", "batch.completed"]),
            ).order_by(JobEvent.id))).all())
            self.assertEqual([(event.type, event.batch_id) for event in terminal_events], [
                ("job.failed", queued[0].batch_id), ("batch.completed", queued[0].batch_id),
                ("job.cancelled", queued[1].batch_id), ("batch.completed", queued[1].batch_id),
            ])
            self.assertTrue(all(event.payload["optimization_id"] == optimization_id for event in terminal_events))
        await self.advance(optimization_id)
        self.assertFalse(any(job.state == "queued" for job in await self.jobs(optimization_id)))

    async def test_finish_callback_failure_rolls_back_nested_cancellation_and_events(self):
        optimization_id = await self.create(max_trials=3)
        for _ in range(3):
            await self.advance(optimization_id)
            current = [job for job in await self.jobs(optimization_id) if job.state == "queued"][0]
            await self.complete(current.id)
        await self.advance(optimization_id)
        queued = [job for job in await self.jobs(optimization_id) if job.state == "queued"]
        self.assertEqual(len(queued), 2)
        job_ids = [job.id for job in queued]
        async with self.sessions() as db:
            for job in queued:
                db.add(JobRecord(job_id=job.id, attempt_count=job.attempt_count, sequence=1, name="staged", payload={"retained": True}))
            await db.commit()
            event_count = await db.scalar(select(func.count()).select_from(JobEvent))
            optimization_state = (await db.get(Optimization, optimization_id)).state
            submissions = list((await db.scalars(select(StageSubmission).where(StageSubmission.job_id.in_(job_ids)))).all())
            original_submissions = {row.id: (row.state, row.error) for row in submissions}
            trials = [await db.get(Trial, row.trial_id) for row in submissions]
            original_trials = {row.id: (row.state, row.next_stage, row.error) for row in trials}
        original_callback = integration.on_job_finished

        async def fail_after_nested_transition(db, job, result):
            await original_callback(db, job, result)
            if job.id == queued[0].id:
                raise RuntimeError("terminal application persistence failed")

        async with self.sessions() as db:
            await serialize_events(db)
            job = await db.scalar(select(Job).where(Job.id == queued[0].id).with_for_update())
            with patch.object(integration, "on_job_finished", side_effect=fail_after_nested_transition):
                with self.assertRaisesRegex(RuntimeError, "terminal application persistence failed"):
                    await finish_job(db, job, "failed", "build failed")
            await db.rollback()
        async with self.sessions() as db:
            self.assertEqual(set((await db.scalars(select(Job.state).where(Job.id.in_(job_ids)))).all()), {"queued"})
            self.assertEqual((await db.get(Optimization, optimization_id)).state, optimization_state)
            for identity, state in original_submissions.items():
                row = await db.get(StageSubmission, identity)
                self.assertEqual((row.state, row.error), state)
            for identity, state in original_trials.items():
                row = await db.get(Trial, identity)
                self.assertEqual((row.state, row.next_stage, row.error), state)
            for pending in queued:
                batch = await db.get(JobBatch, pending.batch_id)
                self.assertEqual((batch.state, batch.failed, batch.cancelled), ("queued", 0, 0))
            self.assertEqual(await db.scalar(select(func.count()).select_from(JobRecord).where(JobRecord.job_id.in_(job_ids))), 2)
            self.assertEqual(await db.scalar(select(func.count()).select_from(JobEvent)), event_count)

    async def test_restart_marks_interrupted_stage_failed_without_replaying_it(self):
        optimization_id = await self.create(max_trials=1)
        await self.advance(optimization_id)
        first = (await self.jobs(optimization_id))[0]
        async with self.sessions() as db:
            job = await db.get(Job, first.id)
            job.state = "running"
            await db.commit()
            await fail_server_jobs(db, detail="server restarted", restarting=True)
        await self.advance(optimization_id)
        self.assertEqual(len(await self.jobs(optimization_id)), 1)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            self.assertEqual(optimization.state, "paused")
            self.assertIn("server restarted", optimization.pause_reason)

    async def test_first_failure_allows_assigned_sibling_to_finish_only_its_current_stage(self):
        optimization_id = await self.create(max_trials=3)
        for _ in range(3):
            await self.advance(optimization_id)
            current = [job for job in await self.jobs(optimization_id) if job.state == "queued"][0]
            await self.complete(current.id)
        await self.advance(optimization_id)
        queued = [job for job in await self.jobs(optimization_id) if job.state == "queued"]
        self.assertEqual(len(queued), 2)
        async with self.sessions() as db:
            for item in queued:
                job = await db.get(Job, item.id)
                job.state = "running"
                trial = await db.get(Trial, job.artifact_metadata["trial_id"])
                trial.manual_retry_requested = True
            await db.commit()
        await self.complete(queued[0].id, failure="first failure")
        await self.complete(queued[1].id)
        await self.advance(optimization_id)
        await self.advance(optimization_id)
        self.assertEqual(len(await self.jobs(optimization_id)), 5)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            sibling = await db.get(Trial, queued[1].artifact_metadata["trial_id"])
            self.assertEqual((optimization.state, sibling.state, sibling.next_stage), ("paused", "pending", "solve"))
            self.assertFalse(sibling.manual_retry_requested)

    async def test_submission_failure_rolls_back_and_remembers_each_retry_request(self):
        optimization_id = await self.create(max_trials=1)

        async def fail_after_creating_job(db, optimization, trial, catalog):
            await submit_stage(db, optimization, trial, catalog)
            raise ValueError("submission interrupted")

        retry_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        with patch("optimization.controller.submit_stage", side_effect=fail_after_creating_job):
            await self.advance(optimization_id)
            await self.advance(optimization_id)
            for request_id in retry_ids:
                async with self.sessions() as db:
                    optimization = await db.get(Optimization, optimization_id)
                    trial = await db.scalar(select(Trial).where(Trial.optimization_id == optimization_id))
                    self.assertEqual((optimization.state, trial.state), ("paused", "failed"))
                    await request_retry(db, optimization, trial, request_id)
                    await db.commit()
                await self.advance(optimization_id)
                await self.advance(optimization_id)
        self.assertEqual(await self.jobs(optimization_id), [])
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(JobBatch)), 0)
            optimization = await db.get(Optimization, optimization_id)
            trial = await db.scalar(select(Trial).where(Trial.optimization_id == optimization_id))
            self.assertEqual(trial.retry_requests, retry_ids)
            self.assertEqual((await optimization_detail(db, optimization))["retry_count"], 2)
            history = await list_trials(db, optimization, limit=50, offset=0)
            self.assertEqual(history["items"][0]["retry_count"], 2)
            await request_retry(db, optimization, trial, retry_ids[0])
            self.assertEqual(trial.state, "failed")
            self.assertFalse(trial.manual_retry_requested)
            await request_retry(db, optimization, trial, str(uuid.uuid4()))
            await db.commit()
        await self.advance(optimization_id)
        self.assertEqual(len(await self.jobs(optimization_id)), 1)

    async def test_authorized_admin_optimization_keeps_recorded_input_access_without_browser_session(self):
        async with self.sessions() as db:
            optimization = await create_optimization(db, self.request(max_trials=1), self.admin, self.catalog)
            optimization_id = optimization.id
        for _ in range(3):
            await self.advance(optimization_id)
            queued = [job for job in await self.jobs(optimization_id) if job.state == "queued"]
            self.assertEqual(len(queued), 1)
            await self.complete(queued[0].id)
        await self.advance(optimization_id)
        async with self.sessions() as db:
            optimization = await db.get(Optimization, optimization_id)
            trial = await db.scalar(select(Trial).where(Trial.optimization_id == optimization_id))
            self.assertEqual(optimization.state, "completed")
            self.assertEqual((await db.get(Measurement, trial.measurement_id)).user_id, self.admin.id)
            with self.assertRaises(LookupError):
                await get_recorded_data(db, trial.measurement_id, user=self.other)


if __name__ == "__main__":
    unittest.main()
