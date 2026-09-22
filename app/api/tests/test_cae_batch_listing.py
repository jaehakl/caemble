"""Batch summary and detail contracts against a disposable PostgreSQL database."""

from __future__ import annotations

import asyncio
import os
import unittest
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI
from sqlalchemy import delete, event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from test_calculation_database import _create_database, _database_url, _drop_database, _seed_owners, _upgrade
from cae.batches import list_batches
from cae.db import CaeBatch
from cae.router import authenticated, get_db, router
from db import make_async_db_url
from gpstation.db import Job, JobBatch, JobEvent
from models import RoleEnum, UserData


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL tests.")
class CaeBatchListingDatabaseTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        asyncio.run(_create_database(cls.database))
        try:
            _upgrade(cls.database, "head")
            cls.owner_id, cls.other_id, cls.experiment_id, cls.other_experiment_id = asyncio.run(_seed_owners(cls.database))
        except BaseException:
            asyncio.run(_drop_database(cls.database))
            raise

    @classmethod
    def tearDownClass(cls):
        asyncio.run(_drop_database(cls.database))

    async def asyncSetUp(self):
        self.engine = create_async_engine(make_async_db_url(_database_url(self.database)))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.statements = []
        event.listen(self.engine.sync_engine, "before_cursor_execute", self.record_statement)
        async with self.sessions() as db:
            await db.execute(delete(JobBatch))
            await db.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()

    def record_statement(self, connection, cursor, statement, parameters, context, executemany):
        self.statements.append(statement)

    async def create_batches(
        self, count=1, *, user_id=None, experiment_id=None, state="running", read=False,
        finished=False, created_at=None, with_cae=True,
    ):
        rows = []
        async with self.sessions() as db:
            for _ in range(count):
                batch = JobBatch(
                    user_id=user_id or self.owner_id, request_id=str(uuid.uuid4()), request_hash="fixture",
                    total=2, created_count=2, uploaded_count=2, state=state, generation_stopped=True,
                    created_at=created_at or datetime(2026, 1, 1, tzinfo=timezone.utc),
                    finished_at=datetime(2026, 1, 2, tzinfo=timezone.utc) if finished else None,
                )
                db.add(batch)
                await db.flush()
                if with_cae:
                    db.add(CaeBatch(
                        batch_id=batch.id, experiment_id=experiment_id or self.experiment_id,
                        spec={"mode": "generate"},
                    ))
                for index in (1, 2):
                    db.add(Job(
                        user_id=batch.user_id, batch_id=batch.id, item_index=index,
                        handler_type="cae.simulation", slave_app_id="cae", job_mode="websocket",
                        state="running", input={"large_payload": [1.0] * 1000},
                    ))
                change = JobEvent(user_id=batch.user_id, batch_id=batch.id, type="batch.created", payload={})
                db.add(change)
                await db.flush()
                batch.last_event_id = change.id
                batch.read_event_id = change.id if read else 0
                rows.append(batch)
            await db.commit()
        return rows

    async def read_list(self, *, limit=50, offset=0, experiment_id=None, attention_only=False):
        self.statements.clear()
        async with self.sessions() as db:
            result = await list_batches(
                db, self.owner_id, experiment_id=experiment_id, limit=limit, offset=offset,
                attention_only=attention_only,
            )
        self.assertEqual(len(self.statements), 3)
        self.assertNotRegex("\n".join(self.statements), r"(?i)\b(?:from|join)\s+jobs\b")
        self.assertTrue(all("jobs" not in item for item in result["items"]))
        return result

    async def test_one_and_fifty_summary_items_use_three_queries_without_job_reads(self):
        rows = await self.create_batches(50)
        ordered_ids = sorted(row.id for row in rows)
        for limit in (1, 50):
            with self.subTest(limit=limit):
                result = await self.read_list(limit=limit)
                self.assertEqual(result["total"], 50)
                self.assertEqual([item["id"] for item in result["items"]], ordered_ids[:limit])
                self.assertEqual(result["cursor"], max(row.last_event_id for row in rows))
                self.assertEqual(result["items"][0]["jobs_total"], 2)
                self.assertEqual(result["items"][0]["mode"], "generate")
                self.assertEqual(result["items"][0]["experiment_id"], self.experiment_id)

    async def test_history_pagination_is_ordered_and_owner_and_experiment_scoped(self):
        old = await self.create_batches(4)
        newest = await self.create_batches(created_at=datetime(2026, 2, 1, tzinfo=timezone.utc))
        other_experiment = await self.create_batches(experiment_id=self.other_experiment_id)
        non_cae = await self.create_batches(with_cae=False)
        await self.create_batches(user_id=self.other_id)
        first = await self.read_list(limit=2, experiment_id=self.experiment_id)
        middle = await self.read_list(limit=2, offset=2, experiment_id=self.experiment_id)
        last = await self.read_list(limit=2, offset=4, experiment_id=self.experiment_id)
        empty = await self.read_list(offset=5, experiment_id=self.experiment_id)
        self.assertEqual(first["total"], 5)
        self.assertEqual(middle["total"], 5)
        self.assertEqual(last["total"], 5)
        self.assertEqual(empty["items"], [])
        self.assertEqual(
            [item["id"] for page in (first, middle, last) for item in page["items"]],
            [newest[0].id, *sorted(row.id for row in old)],
        )
        result = await self.read_list(experiment_id=self.other_experiment_id)
        self.assertEqual([item["id"] for item in result["items"]], [other_experiment[0].id])
        owner_events = [*old, *newest, *other_experiment, *non_cae]
        self.assertEqual(first["cursor"], max(row.last_event_id for row in owner_events))

    async def test_attention_includes_old_active_and_unread_terminal_batches(self):
        active = []
        for state in ("uploading", "queued", "running"):
            active.extend(await self.create_batches(state=state, read=True))
        unread = []
        for state in ("completed", "cancelled"):
            unread.extend(await self.create_batches(state=state, finished=True))
        await self.create_batches(51, state="completed", finished=True, read=True,
                                  created_at=datetime(2026, 3, 1, tzinfo=timezone.utc))
        await self.create_batches(state="cancelled", finished=True, read=True)
        await self.create_batches(state="completed", finished=False)
        await self.create_batches(user_id=self.other_id, state="running")
        await self.create_batches(user_id=self.other_id, state="completed", finished=True)
        other_experiment = await self.create_batches(experiment_id=self.other_experiment_id)

        recent = await self.read_list()
        expected = sorted(row.id for row in [*active, *unread])
        self.assertTrue(set(expected).isdisjoint(item["id"] for item in recent["items"]))
        pages = [await self.read_list(limit=2, offset=offset, experiment_id=self.experiment_id, attention_only=True)
                 for offset in (0, 2, 4)]
        self.assertTrue(all(page["total"] == 5 for page in pages))
        self.assertEqual([item["id"] for page in pages for item in page["items"]], expected)
        all_attention = await self.read_list(attention_only=True)
        self.assertEqual({item["id"] for item in all_attention["items"]}, {*expected, other_experiment[0].id})

    async def test_http_summary_detail_skips_jobs_and_detail_pagination_remains_available(self):
        batch = (await self.create_batches())[0]
        other = (await self.create_batches(user_id=self.other_id))[0]
        app = FastAPI()
        app.include_router(router)

        async def session():
            async with self.sessions() as db:
                yield db

        app.dependency_overrides[get_db] = session
        app.dependency_overrides[authenticated] = lambda: UserData(id=self.owner_id, roles=[RoleEnum.user])
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local.test") as client:
            self.statements.clear()
            response = await client.get(f"/cae/batches/{batch.id}?limit=0")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["jobs"], [])
            self.assertEqual(response.json()["jobs_total"], 2)
            self.assertEqual(len(self.statements), 2)
            self.assertNotRegex("\n".join(self.statements), r"(?i)\b(?:from|join)\s+jobs\b")
            response = await client.get(f"/cae/batches/{batch.id}?limit=1&offset=1")
            self.assertEqual(response.status_code, 200)
            self.assertEqual([job["index"] for job in response.json()["jobs"]], [2])
            self.assertEqual(response.json()["jobs_total"], 2)
            self.assertEqual((await client.get(f"/cae/batches/{batch.id}?limit=-1")).status_code, 422)
            self.assertEqual((await client.get(f"/cae/batches/{other.id}?limit=0")).status_code, 404)
            response = await client.get("/cae/batches?attention_only=true&limit=1")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["total"], 1)
            self.assertEqual(response.json()["items"][0]["id"], batch.id)
            self.assertNotIn("jobs", response.json()["items"][0])
