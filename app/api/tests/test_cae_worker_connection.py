from __future__ import annotations

import asyncio
import base64
import os
import socket
import struct
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
import uvicorn

from cae import recording
from cae.db import CaeBatch
from cae.recording import persist_record
from db import ExperimentRecord, Measurement, RecordedData, make_async_db_url
from gpstation.db import Job, JobBatch, JobEvent, JobRecord, Launcher
from gpstation.service import worker_connection
from gpstation.service.server_handlers import server_handlers
from gpstation.service.state import runtime, utcnow
from sdk.protocol.packets import Attachment
from sdk.slave.server import ServerSlaveApp, run_server_job
from settings import settings
from test_calculation_database import (
    _create_database,
    _database_url,
    _drop_database,
    _seed_owners,
    _upgrade,
)


class RecordPersistenceTests(unittest.TestCase):
    def test_cookie_batch_mutations_require_csrf(self):
        from cae.router import router

        app = FastAPI()
        app.include_router(router)
        batch_id = str(uuid.uuid4())
        with TestClient(app) as client:
            for path in (
                "/cae/batches",
                *(f"/cae/batches/{batch_id}/{action}" for action in ("cancel", "retry", "read")),
            ):
                with self.subTest(path=path):
                    response = client.post(path, json={})
                    self.assertEqual(response.status_code, 403)
                    self.assertEqual(response.json()["detail"], "CSRF token required")

    def test_empty_axes_and_large_attachment_shape_are_preserved(self):
        for shape, expected in (
            ([2, 0, 3], [[], []]),
            ([2, 3, 0], [[[], [], []], [[], [], []]]),
            ([0, 2], []),
        ):
            with self.subTest(shape=shape):
                tensor = {
                    "shape": shape,
                    "storage": {"kind": "attachments", "ids": ["a"], "byteLength": 0},
                }
                self.assertEqual(
                    persist_record({"dtype": "float64"}, tensor, {"a": b""})["storage"]["value"],
                    expected,
                )
        raw = bytes(80000)
        tensor = {
            "shape": [1],
            "storage": {"kind": "attachments", "ids": ["a"], "byteLength": len(raw)},
        }
        with self.assertRaisesRegex(ValueError, "shape"):
            persist_record({"dtype": "float64"}, tensor, {"a": raw})

    def test_small_binary_preserves_shape_boolean_and_korean_strings(self):
        tensor = {
            "shape": [2, 2],
            "storage": {"kind": "attachments", "ids": ["a"], "byteLength": 4},
        }
        self.assertEqual(
            persist_record({"dtype": "bool"}, tensor, {"a": bytes([0, 1, 1, 0])})["storage"],
            {"kind": "inline", "value": [[False, True], [True, False]]},
        )
        raw = '["한글","결과"]'.encode("utf-8")
        tensor = {
            "shape": [2],
            "storage": {"kind": "attachments", "ids": ["a"], "byteLength": len(raw)},
        }
        self.assertEqual(
            persist_record({"dtype": "string"}, tensor, {"a": raw})["storage"]["value"],
            ["한글", "결과"],
        )


@unittest.skipUnless(
    os.getenv("RUN_CAE_DB_TESTS") == "1",
    "Set RUN_CAE_DB_TESTS=1 for disposable PostgreSQL/loopback WebSocket tests.",
)
class WorkerConnectionTests(unittest.TestCase):
    def test_result_commits_without_browser_and_cleanup_cannot_release_new_job(self):
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        asyncio.run(_create_database(database))
        try:
            _upgrade(database, "head")
            asyncio.run(self._verify_worker(database))
        finally:
            asyncio.run(_drop_database(database))

    async def _verify_worker(self, database: str):
        owner, _, experiment_id, _ = await _seed_owners(database)
        engine = create_async_engine(make_async_db_url(_database_url(database)))
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        schema = {"dtype": "float64"}
        async with sessions() as db:
            batch = JobBatch(
                user_id=owner,
                request_id=str(uuid.uuid4()),
                request_hash="test",
                total=1,
                created_count=1,
                succeeded=0,
                failed=0,
                cancelled=0,
                state="running",
            )
            launcher = Launcher(
                user_id=owner,
                launcher_name="loopback",
                slave_app_ids=["cae"],
                job_modes={"cae": "websocket"},
                status="busy",
                connected_at=utcnow(),
                last_heartbeat_at=utcnow(),
            )
            db.add_all([batch, launcher])
            await db.flush()
            db.add(
                CaeBatch(batch_id=batch.id, experiment_id=experiment_id, spec={"mode": "generate"})
            )
            job = Job(
                user_id=owner,
                launcher_id=launcher.id,
                handler_type="cae.simulation",
                slave_app_id="cae",
                job_mode="websocket",
                batch_id=batch.id,
                item_index=1,
                state="assigned",
                attempt_count=1,
                input={
                    "measurement": {
                        "experiment": {"simulationProgram": {"recordedData": {"signal": schema}}}
                    }
                },
            )
            db.add(job)
            await db.flush()
            measurement = Measurement(
                user_id=owner,
                experiment_id=experiment_id,
                vars={},
                material_parameters={},
                job_id=job.id,
            )
            db.add_all(
                [
                    measurement,
                    ExperimentRecord(
                        experiment_id=experiment_id,
                        name="signal",
                        tensor_order=0,
                        dtype="float64",
                        data_schema=schema,
                        contract_hash="test",
                    ),
                ]
            )
            await db.commit()
            assignment = await worker_connection.worker_assignment(db, job)
        await runtime.register_launcher(launcher.id, AsyncMock(), "test-key")
        await runtime.mark_launcher_job(launcher.id, job.id)
        server_handlers["cae.simulation"] = recording
        app = FastAPI()

        @app.websocket("/jobs/{job_id}")
        async def stream(websocket: WebSocket, job_id: str):
            await worker_connection.run_worker_connection(websocket, job_id)

        raw = struct.pack("<100000d", *range(100000))
        staged = asyncio.Event()
        finish = asyncio.Event()
        cleaned = asyncio.Event()

        async def compute(payload, attachments, context):
            self.assertIn("measurement", payload)
            await context.send(
                {"type": "job.progress", "progress": {"stage": "계산", "completed": 1, "total": 2}}
            )
            packet = {
                "type": "job.record",
                "sequence": 1,
                "name": "signal",
                "value": {
                    "shape": [100000],
                    "axes": [{"ticks": list(range(100000))}],
                    "storage": {"kind": "attachments", "ids": ["signal"], "byteLength": len(raw)},
                },
            }
            attachment = Attachment(id="signal", data=raw)
            for _ in range(2):
                await context.send(packet, [attachment])
                ack, _ = await context.receive()
                self.assertEqual(ack, {"type": "job.record.ack", "sequence": 1})
            staged.set()
            await finish.wait()
            cleaned.set()
            return {"recordSequences": [1]}

        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        assignment["websocket_url"] = f"ws://127.0.0.1:{listener.getsockname()[1]}/jobs/{job.id}"
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
        emitted = []
        try:
            with patch.object(worker_connection, "SessionLocal", sessions), patch(
                "sdk.slave.server.emit", side_effect=emitted.append
            ):
                server_task = asyncio.create_task(server.serve(sockets=[listener]))
                while not server.started:
                    await asyncio.sleep(0.01)
                worker_task = asyncio.create_task(
                    run_server_job(ServerSlaveApp(compute), assignment)
                )
                await asyncio.wait_for(staged.wait(), timeout=20)
                async with sessions() as db:
                    self.assertEqual(
                        await db.scalar(select(func.count()).select_from(JobRecord)), 1
                    )
                    self.assertEqual(
                        await db.scalar(select(func.count()).select_from(RecordedData)), 0
                    )
                    self.assertIsNone((await db.get(Measurement, measurement.id)).recorded_at)
                finish.set()
                await asyncio.wait_for(worker_task, timeout=20)
                self.assertTrue(cleaned.is_set())
                self.assertEqual([event["type"] for event in emitted], ["job.cleaned"])
                async with sessions() as db:
                    stored = await db.scalar(select(RecordedData))
                    self.assertEqual(base64.b64decode(stored.data["storage"]["data"]), raw)
                    self.assertEqual((await db.get(Job, job.id)).state, "succeeded")
                    self.assertEqual((await db.get(JobBatch, batch.id)).succeeded, 1)
                    self.assertEqual(
                        await db.scalar(select(func.count()).select_from(JobRecord)), 0
                    )
                    self.assertIsNotNone((await db.get(Measurement, measurement.id)).recorded_at)
                    kinds = list(
                        (await db.scalars(select(JobEvent.type).order_by(JobEvent.id))).all()
                    )
                    self.assertEqual(kinds[-2:], ["job.succeeded", "batch.completed"])
                    self.assertTrue(await runtime.launcher_matches_job(launcher.id, job.id))
                    self.assertTrue(
                        await worker_connection.worker_cleaned(
                            db,
                            job_id=job.id,
                            attempt_count=1,
                            launcher_id=launcher.id,
                            user_id=owner,
                        )
                    )
                    await runtime.mark_launcher_job(launcher.id, "next-job")
                    self.assertTrue(
                        await worker_connection.worker_cleaned(
                            db,
                            job_id=job.id,
                            attempt_count=1,
                            launcher_id=launcher.id,
                            user_id=owner,
                        )
                    )
                    self.assertTrue(await runtime.launcher_matches_job(launcher.id, "next-job"))
        finally:
            finish.set()
            server.should_exit = True
            if "server_task" in locals():
                await server_task
            listener.close()
            await runtime.remove_launcher(launcher.id)
            await engine.dispose()
