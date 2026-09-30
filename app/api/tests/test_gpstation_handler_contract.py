"""Execution callbacks preserve the caller's transaction and terminal event order."""
from __future__ import annotations

from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from gpstation.db import JobBatch, JobEvent
from gpstation.service.batches import add_event, finish_job
from gpstation.service.server_handlers import register_server_handler, server_handlers
from model_registry import register_models
from optimization import integration


class HandlerContractTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        register_models()
        handlers = patch.dict(server_handlers, clear=True)
        handlers.start()
        self.addCleanup(handlers.stop)
        self.batch = JobBatch(id="batch", user_id="owner", state="running", total=1, succeeded=0, failed=0, cancelled=0)
        self.events: list[JobEvent] = []
        self.trace: list[str] = []

        async def execute(statement):
            self.trace.append(f"delete:{statement.table.name}")

        def add(row):
            self.events.append(row)
            self.trace.append(f"event:{row.type}:{row.job_id}")

        async def flush():
            for index, event in enumerate(self.events, 1):
                event.id = index

        self.db = SimpleNamespace(
            scalar=AsyncMock(return_value=self.batch), execute=AsyncMock(side_effect=execute),
            add=Mock(side_effect=add), flush=AsyncMock(side_effect=flush),
            commit=AsyncMock(), rollback=AsyncMock(), refresh=AsyncMock(),
        )

    def job(self, identity="job"):
        return SimpleNamespace(
            id=identity, user_id="owner", batch_id="batch", state="running", handler_type="example.compute",
            attempt_count=1, attempt_id=None, reservation_id=None, cleaned_at=None,
            launcher_id="launcher", boot_id="boot", instance_id=f"instance-{identity}",
            artifact_metadata={},
        )

    async def test_terminal_events_precede_callback_in_the_same_session(self):
        job = self.job()
        context = AsyncMock(return_value={"workflow_id": "workflow"})

        async def on_finished(db, finished, result):
            self.assertIs(db, self.db)
            self.assertIs(finished, job)
            self.assertEqual(result, {"answer": 42})
            self.assertEqual([event.type for event in self.events], ["job.succeeded", "batch.completed"])
            self.assertEqual(self.batch.last_event_id, 2)
            self.trace.append("finished")

        callback = AsyncMock(side_effect=on_finished)
        register_server_handler(job.handler_type, SimpleNamespace(), event_context=context, on_finished=callback)
        self.assertTrue(await finish_job(self.db, job, "succeeded", result={"answer": 42}))
        self.assertEqual(self.trace, ["delete:job_records", "delete:job_visualizations", "event:job.succeeded:job", "event:batch.completed:None", "finished"])
        self.assertTrue(all(event.payload["workflow_id"] == "workflow" for event in self.events))
        self.assertEqual(self.events[0].payload["instance_id"], "instance-job")
        self.assertFalse(await finish_job(self.db, job, "succeeded"))
        callback.assert_awaited_once()
        self.db.commit.assert_not_awaited()
        self.db.rollback.assert_not_awaited()

    async def test_callback_failure_propagates_without_owning_commit_or_rollback(self):
        job = self.job()
        failure = RuntimeError("application result could not be persisted")
        callback = AsyncMock(side_effect=failure)
        register_server_handler(job.handler_type, SimpleNamespace(), on_finished=callback)
        with self.assertRaises(RuntimeError) as caught:
            await finish_job(self.db, job, "failed", "execution failed")
        self.assertIs(caught.exception, failure)
        callback.assert_awaited_once_with(self.db, job, None)
        self.assertEqual([event.type for event in self.events], ["job.failed", "batch.completed"])
        self.db.commit.assert_not_awaited()
        self.db.rollback.assert_not_awaited()

    async def test_nested_sibling_finish_is_not_suppressed_or_repeated(self):
        first, sibling = self.job("first"), self.job("sibling")
        self.batch.total = 2

        async def on_finished(db, job, result):
            self.assertIs(db, self.db)
            self.trace.append(f"finished:{job.id}")
            if job is first:
                self.assertTrue(await finish_job(db, sibling, "cancelled", "parent workflow stopped"))
                self.assertFalse(await finish_job(db, sibling, "cancelled"))

        callback = AsyncMock(side_effect=on_finished)
        register_server_handler(first.handler_type, SimpleNamespace(), on_finished=callback)
        self.assertTrue(await finish_job(self.db, first, "failed"))
        self.assertEqual([(event.type, event.job_id) for event in self.events], [
            ("job.failed", "first"), ("job.cancelled", "sibling"), ("batch.completed", None),
        ])
        self.assertEqual((self.batch.failed, self.batch.cancelled, self.batch.state), (1, 1, "completed"))
        self.assertEqual(callback.await_count, 2)
        self.assertLess(self.trace.index("event:job.failed:first"), self.trace.index("finished:first"))
        self.assertLess(self.trace.index("event:batch.completed:None"), self.trace.index("finished:sibling"))
        self.db.commit.assert_not_awaited()

    async def test_event_identity_is_snapshotted_before_a_later_attempt(self):
        job = self.job()
        event = await add_event(self.db, self.batch, "job.running", job=job)
        job.attempt_count, job.instance_id = 2, "replacement-instance"
        self.assertEqual(event.attempt_count, 1)
        self.assertEqual(event.payload["instance_id"], "instance-job")
        self.assertEqual(event.payload["job_id"], job.id)


class OptimizationHandlerContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_deferred_metadata_reads_only_attribution(self):
        job = SimpleNamespace(id="job")
        db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(one=lambda: ("optimization", "trial", "solve"))))
        context = await integration.event_context(db, job)
        self.assertEqual(context, {"optimization_id": "optimization", "trial_id": "trial", "stage": "solve"})
        statement = db.execute.call_args.args[0]
        self.assertEqual(len(statement.selected_columns), 3)
        self.assertNotIn("jobs.input", str(statement))
        self.assertNotIn("artifact_metadata", job.__dict__)

    async def test_only_owned_workflows_load_metadata_before_transition(self):
        job = SimpleNamespace(id="job")
        db = SimpleNamespace(refresh=AsyncMock())
        with patch.object(integration, "event_context", AsyncMock(return_value={})), patch.object(integration, "on_job_finished", AsyncMock()) as callback:
            await integration.on_finished(db, job, None)
            db.refresh.assert_not_awaited()
            callback.assert_not_awaited()
        with patch.object(integration, "event_context", AsyncMock(return_value={"optimization_id": "optimization"})), patch.object(integration, "on_job_finished", AsyncMock()) as callback:
            await integration.on_finished(db, job, {"answer": 42})
            db.refresh.assert_awaited_once_with(job, ["artifact_metadata"])
            callback.assert_awaited_once_with(db, job, {"answer": 42})


if __name__ == "__main__":
    unittest.main()
