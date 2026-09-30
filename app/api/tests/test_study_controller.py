"""Real DB transitions with inexpensive stage results, without product Solvers."""

import asyncio
import os
import unittest
import uuid
from unittest.mock import patch

import test_parameter_study_api as persistence_fixture

from simulation.services import recording
from optimization import evaluation, integration
from optimization.controller import cancel_study, reconcile_study, request_retry
from optimization.db import StageSubmission, Study, Trial
from optimization.service import create_study, list_trials, resume_study, study_detail
from optimization.submissions import submit_stage
from simulation.db import Measurement
from gpstation.db import Job, JobBatch, JobEvent, JobRecord
from gpstation.service.batches import fail_server_jobs, finish_job, serialize_events
from simulation.services.material_snapshot import material_vars_hash
from simulation.services.measurements import get_recorded_data
from sqlalchemy import func, select


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class StudyControllerTests(unittest.IsolatedAsyncioTestCase):
    setUpClass = classmethod(persistence_fixture.StudyPersistenceTests.setUpClass.__func__)
    tearDownClass = classmethod(persistence_fixture.StudyPersistenceTests.tearDownClass.__func__)
    asyncSetUp = persistence_fixture.StudyPersistenceTests.asyncSetUp
    asyncTearDown = persistence_fixture.StudyPersistenceTests.asyncTearDown
    request = persistence_fixture.StudyPersistenceTests.request

    async def create(self, **overrides):
        async with self.sessions() as db:
            study = await create_study(db, self.request(**overrides), self.owner, self.catalog)
            return study.id

    async def advance(self, study_id):
        async with self.sessions() as db:
            await serialize_events(db)
            study = await db.scalar(select(Study).where(Study.id == study_id).with_for_update())
            await reconcile_study(db, study, self.catalog)
            await db.commit()

    async def jobs(self, study_id):
        async with self.sessions() as db:
            return list((await db.scalars(select(Job).join(StageSubmission, StageSubmission.job_id == Job.id)
                                         .join(Trial, Trial.id == StageSubmission.trial_id)
                                         .where(Trial.study_id == study_id).order_by(Job.created_at))).all())

    async def complete(self, job_id, *, failure=None):
        async with self.sessions() as db:
            await serialize_events(db)
            job = await db.get(Job, job_id)
            if failure:
                await finish_job(db, job, "failed", failure)
                await db.commit()
                return
            study = await db.get(Study, job.artifact_metadata["study_id"])
            trial = await db.get(Trial, job.artifact_metadata["trial_id"])
            if job.handler_type == "cae.simulation":
                result = await recording.complete_job(db, job, {"recordSequences": [], "visualizationSequences": []})
            else:
                if job.input["stage"] == "build":
                    value = {"input": {"measurement": {"kind": "measurement", "experiment": {
                        "sourceHash": study.definition["source_hash"], "variables": trial.variables,
                        "varsSchema": study.definition["vars_schema"], "scene": {}, "taskScenes": {},
                        "simulationProgram": {"pythonSource": study.definition["source_bundle"]["files"]["simulate.py"],
                                              "tasks": {}, "recordedData": {}, "resultContracts": {}}},
                        "materialSnapshot": {"materials": {}}, "taskMaterialSnapshots": {}, "modelDefinitions": [],
                        "materialSelections": {}, "varsHash": material_vars_hash(trial.variables)}}}
                else:
                    value = {"measurement_id": trial.measurement_id, "calculations": [{
                        "key": "objective", "source_hash": study.definition["calculations"][0]["source_hash"],
                        "value": sum(trial.variables["x"]),
                    }]}
                packet = {"sequence": 1, "name": job.input["stage"], "value": value}
                await evaluation.stage_record(db, job, packet, [])
                await db.flush()
                result = await evaluation.complete_job(db, job, {"recordSequences": [1],
                    "definition_hash": study.definition["hash"], "runtime_id": "test-runtime"})
            self.assertTrue(await finish_job(db, job, "succeeded", result=result))
            self.assertFalse(await finish_job(db, job, "succeeded", result=result))
            await db.commit()

    async def test_concurrent_reconciliation_build_solve_calculate_and_budget(self):
        study_id = await self.create(max_trials=3)
        await asyncio.gather(self.advance(study_id), self.advance(study_id))
        self.assertEqual(len(await self.jobs(study_id)), 1)
        for _ in range(12):
            for job in await self.jobs(study_id):
                if job.state == "queued":
                    await self.complete(job.id)
            await asyncio.gather(self.advance(study_id), self.advance(study_id))
            async with self.sessions() as db:
                study = await db.get(Study, study_id)
                if study.state == "completed":
                    break
        self.assertEqual(study.state, "completed")
        jobs = await self.jobs(study_id)
        self.assertEqual(len(jobs), 9)
        self.assertEqual(len({job.batch_id for job in jobs}), 9)
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(Measurement)), 3)
            self.assertIsNotNone(study.best_trial_id)
            events = list((await db.scalars(select(JobEvent).where(JobEvent.batch_id.in_([job.batch_id for job in jobs])))).all())
            self.assertTrue(all(event.payload.get("study_id") == study_id for event in events))

    async def test_calculation_failure_retry_reuses_solver_and_preserves_old_batch(self):
        study_id = await self.create(max_trials=1)
        await self.advance(study_id)
        for _ in range(2):
            current = [job for job in await self.jobs(study_id) if job.state == "queued"][0]
            await self.complete(current.id)
            await self.advance(study_id)
        failed = [job for job in await self.jobs(study_id) if job.state == "queued"][0]
        await self.complete(failed.id, failure="calculation failed")
        await self.advance(study_id)
        retry_id = str(uuid.uuid4())
        async with self.sessions() as db:
            await serialize_events(db)
            study = await db.get(Study, study_id)
            trial = await db.scalar(select(Trial).where(Trial.study_id == study_id))
            self.assertEqual((study.state, trial.next_stage), ("paused", "calculate"))
            measurement_id = trial.measurement_id
            await request_retry(db, study, trial, retry_id)
            await request_retry(db, study, trial, retry_id)
            await db.commit()
        await self.advance(study_id)
        retried = [job for job in await self.jobs(study_id) if job.state == "queued"][0]
        self.assertNotEqual(retried.batch_id, failed.batch_id)
        await self.complete(retried.id)
        async with self.sessions() as db:
            study = await db.get(Study, study_id)
            trial = await db.scalar(select(Trial).where(Trial.study_id == study_id))
            self.assertEqual((study.state, trial.state, trial.measurement_id), ("paused", "succeeded", measurement_id))
            original = await db.get(JobBatch, failed.batch_id)
            self.assertEqual((original.state, original.failed), ("completed", 1))
            await resume_study(db, study)
            await db.commit()
        await self.advance(study_id)
        self.assertEqual(sum(job.handler_type == "cae.simulation" for job in await self.jobs(study_id)), 1)

    async def test_stop_resume_and_first_failure_cancel_queued_siblings(self):
        study_id = await self.create(max_trials=5)
        await self.advance(study_id)
        first = (await self.jobs(study_id))[0]
        async with self.sessions() as db:
            await serialize_events(db)
            study = await db.get(Study, study_id)
            await cancel_study(db, study)
            await db.commit()
        await self.advance(study_id)
        async with self.sessions() as db:
            study = await db.get(Study, study_id)
            self.assertEqual(study.state, "paused")
            await resume_study(db, study)
            await db.commit()
        for _ in range(3):
            await self.advance(study_id)
            queued = [job for job in await self.jobs(study_id) if job.state == "queued"]
            self.assertEqual(len(queued), 1)
            await self.complete(queued[0].id)
        await self.advance(study_id)
        queued = [job for job in await self.jobs(study_id) if job.state == "queued"]
        self.assertEqual(len(queued), 2)
        await self.complete(queued[0].id, failure="build failed")
        async with self.sessions() as db:
            self.assertEqual((await db.get(Job, queued[1].id)).state, "cancelled")
            self.assertEqual((await db.get(Job, first.id)).state, "cancelled")
            self.assertEqual((await db.get(Study, study_id)).state, "pausing")
            terminal_events = list((await db.scalars(select(JobEvent).where(
                JobEvent.batch_id.in_([job.batch_id for job in queued]),
                JobEvent.type.in_(["job.failed", "job.cancelled", "batch.completed"]),
            ).order_by(JobEvent.id))).all())
            self.assertEqual([(event.type, event.batch_id) for event in terminal_events], [
                ("job.failed", queued[0].batch_id), ("batch.completed", queued[0].batch_id),
                ("job.cancelled", queued[1].batch_id), ("batch.completed", queued[1].batch_id),
            ])
            self.assertTrue(all(event.payload["study_id"] == study_id for event in terminal_events))
        await self.advance(study_id)
        self.assertFalse(any(job.state == "queued" for job in await self.jobs(study_id)))

    async def test_finish_callback_failure_rolls_back_nested_cancellation_and_events(self):
        study_id = await self.create(max_trials=3)
        for _ in range(3):
            await self.advance(study_id)
            current = [job for job in await self.jobs(study_id) if job.state == "queued"][0]
            await self.complete(current.id)
        await self.advance(study_id)
        queued = [job for job in await self.jobs(study_id) if job.state == "queued"]
        self.assertEqual(len(queued), 2)
        job_ids = [job.id for job in queued]
        async with self.sessions() as db:
            for job in queued:
                db.add(JobRecord(job_id=job.id, attempt_count=job.attempt_count, sequence=1, name="staged", payload={"retained": True}))
            await db.commit()
            event_count = await db.scalar(select(func.count()).select_from(JobEvent))
            study_state = (await db.get(Study, study_id)).state
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
            self.assertEqual((await db.get(Study, study_id)).state, study_state)
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
        study_id = await self.create(max_trials=1)
        await self.advance(study_id)
        first = (await self.jobs(study_id))[0]
        async with self.sessions() as db:
            job = await db.get(Job, first.id)
            job.state = "running"
            await db.commit()
            await fail_server_jobs(db, detail="server restarted", restarting=True)
        await self.advance(study_id)
        self.assertEqual(len(await self.jobs(study_id)), 1)
        async with self.sessions() as db:
            study = await db.get(Study, study_id)
            self.assertEqual(study.state, "paused")
            self.assertIn("server restarted", study.pause_reason)

    async def test_first_failure_allows_assigned_sibling_to_finish_only_its_current_stage(self):
        study_id = await self.create(max_trials=3)
        for _ in range(3):
            await self.advance(study_id)
            current = [job for job in await self.jobs(study_id) if job.state == "queued"][0]
            await self.complete(current.id)
        await self.advance(study_id)
        queued = [job for job in await self.jobs(study_id) if job.state == "queued"]
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
        await self.advance(study_id)
        await self.advance(study_id)
        self.assertEqual(len(await self.jobs(study_id)), 5)
        async with self.sessions() as db:
            study = await db.get(Study, study_id)
            sibling = await db.get(Trial, queued[1].artifact_metadata["trial_id"])
            self.assertEqual((study.state, sibling.state, sibling.next_stage), ("paused", "pending", "solve"))
            self.assertFalse(sibling.manual_retry_requested)

    async def test_submission_failure_rolls_back_and_remembers_each_retry_request(self):
        study_id = await self.create(max_trials=1)

        async def fail_after_creating_job(db, study, trial, catalog):
            await submit_stage(db, study, trial, catalog)
            raise ValueError("submission interrupted")

        retry_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        with patch("optimization.controller.submit_stage", side_effect=fail_after_creating_job):
            await self.advance(study_id)
            await self.advance(study_id)
            for request_id in retry_ids:
                async with self.sessions() as db:
                    study = await db.get(Study, study_id)
                    trial = await db.scalar(select(Trial).where(Trial.study_id == study_id))
                    self.assertEqual((study.state, trial.state), ("paused", "failed"))
                    await request_retry(db, study, trial, request_id)
                    await db.commit()
                await self.advance(study_id)
                await self.advance(study_id)
        self.assertEqual(await self.jobs(study_id), [])
        async with self.sessions() as db:
            self.assertEqual(await db.scalar(select(func.count()).select_from(JobBatch)), 0)
            study = await db.get(Study, study_id)
            trial = await db.scalar(select(Trial).where(Trial.study_id == study_id))
            self.assertEqual(trial.retry_requests, retry_ids)
            self.assertEqual((await study_detail(db, study))["retry_count"], 2)
            history = await list_trials(db, study, limit=50, offset=0)
            self.assertEqual(history["items"][0]["retry_count"], 2)
            await request_retry(db, study, trial, retry_ids[0])
            self.assertEqual(trial.state, "failed")
            self.assertFalse(trial.manual_retry_requested)
            await request_retry(db, study, trial, str(uuid.uuid4()))
            await db.commit()
        await self.advance(study_id)
        self.assertEqual(len(await self.jobs(study_id)), 1)

    async def test_authorized_admin_study_keeps_recorded_input_access_without_browser_session(self):
        async with self.sessions() as db:
            study = await create_study(db, self.request(max_trials=1), self.admin, self.catalog)
            study_id = study.id
        for _ in range(3):
            await self.advance(study_id)
            queued = [job for job in await self.jobs(study_id) if job.state == "queued"]
            self.assertEqual(len(queued), 1)
            await self.complete(queued[0].id)
        await self.advance(study_id)
        async with self.sessions() as db:
            study = await db.get(Study, study_id)
            trial = await db.scalar(select(Trial).where(Trial.study_id == study_id))
            self.assertEqual(study.state, "completed")
            self.assertEqual((await db.get(Measurement, trial.measurement_id)).user_id, self.admin.id)
            with self.assertRaises(LookupError):
                await get_recorded_data(db, trial.measurement_id, user=self.other)


if __name__ == "__main__":
    unittest.main()
