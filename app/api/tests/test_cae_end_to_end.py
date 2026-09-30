"""Opt-in public CLI build, real CAE child, WebSocket, and PostgreSQL integration."""
from __future__ import annotations

import asyncio
import os
import socket
import sys
import unittest
import uuid
from datetime import timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from fastapi import FastAPI, WebSocket
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
import uvicorn
import websockets

from simulation.services import recording
from simulation.services.batches import cancel_batch
from simulation.db import CaeBatch
from simulation.db import ExperimentRecord, Measurement, RecordedData
from db import make_async_db_url
from gpstation.db import Job, JobBatch, JobRecord, Launcher
from gpstation.service import worker_connection
from gpstation.service.job_service import JobService
from gpstation.service.execution import execution_identity, sync_attempt
from gpstation.service.server_handlers import server_handlers
from gpstation.service.state import runtime, utcnow
from sdk.protocol.packets import receive_packet, send_packet
from test_calculation_database import _create_database, _database_url, _drop_database, _seed_owners, _upgrade
from box_grid_fixtures import box_schema, box_tensor


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for the real CAE process integration test.")
class CaeEndToEndTests(unittest.TestCase):
    def test_duplicate_handshake_cannot_fail_the_connected_worker(self):
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        asyncio.run(_create_database(database))
        try:
            _upgrade(database, "head")
            asyncio.run(self._verify_transport_boundary(database, "duplicate"))
        finally:
            asyncio.run(_drop_database(database))

    def test_stale_attempt_and_interrupted_records(self):
        for scenario in ("stale_attempt", "cancel_before_complete", "disconnect_after_staging"):
            with self.subTest(scenario=scenario):
                database = f"caemble_calculation_test_{uuid.uuid4().hex}"
                asyncio.run(_create_database(database))
                try:
                    _upgrade(database, "head")
                    asyncio.run(self._verify_transport_boundary(database, scenario))
                finally:
                    asyncio.run(_drop_database(database))

    def test_packet_liveness_uses_idle_time_between_frames(self):
        for scenario in ("continuous_chunks", "idle"):
            with self.subTest(scenario=scenario):
                database = f"caemble_calculation_test_{uuid.uuid4().hex}"
                asyncio.run(_create_database(database))
                try:
                    _upgrade(database, "head")
                    asyncio.run(self._verify_transport_boundary(database, scenario))
                finally:
                    asyncio.run(_drop_database(database))

    async def _verify_transport_boundary(self, database, scenario):
        owner, _, experiment_id, _ = await _seed_owners(database)
        engine = create_async_engine(make_async_db_url(_database_url(database)))
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as db:
            batch = JobBatch(user_id=owner, request_id=str(uuid.uuid4()), request_hash="duplicate", total=1,
                             created_count=1, succeeded=0, failed=0, cancelled=0, state="running")
            launcher = Launcher(user_id=owner, launcher_name="duplicate", slave_app_ids=["cae"],
                                job_modes={"cae": "websocket"}, boot_id=str(uuid.uuid4()), session_id=str(uuid.uuid4()),
                                status="busy", connected_at=utcnow(), last_heartbeat_at=utcnow())
            db.add_all([batch, launcher])
            await db.flush()
            db.add(CaeBatch(batch_id=batch.id, experiment_id=experiment_id, spec={"mode": "generate"}))
            schema = box_schema()
            job = Job(user_id=owner, launcher_id=launcher.id, handler_type="cae.simulation", slave_app_id="cae",
                      job_mode="websocket", batch_id=batch.id, item_index=1, state="assigned", attempt_count=1,
                      boot_id=launcher.boot_id, attempt_id=str(uuid.uuid4()), instance_id=str(uuid.uuid4()),
                      reservation_id=str(uuid.uuid4()), execution_phase="start_authorized", cleanup_state="pending",
                      allocation={"cpu_ids": [0], "cpu_cores": 1, "startup_ram_bytes": 1024 ** 3,
                                  "ram_available_bytes": 1024 ** 3, "gpu_devices": [], "gpu_memory_bytes": 0},
                      input={"measurement": {"experiment": {"simulationProgram": {
                          "recordedData": {"result": schema}, "resultContracts": {"result": box_tensor()["provenance"]}}}}})
            db.add(job)
            await db.flush()
            await sync_attempt(db, job)
            measurement = Measurement(user_id=owner, experiment_id=experiment_id, job_id=job.id,
                                      vars={}, material_snapshot={})
            db.add(measurement)
            db.add(ExperimentRecord(experiment_id=experiment_id, name="result", tensor_order=7,
                                    dtype="float64", data_schema=schema, contract_hash="transport-test"))
            await db.commit()
            assignment = await worker_connection.worker_assignment(db, job)
        await runtime.register_launcher(launcher.id, AsyncMock(), "test-key", boot_id=launcher.boot_id, session_id=launcher.session_id)
        await runtime.mark_instance(launcher.id, {**execution_identity(job), "state": "starting", "slave_app_id": "cae"})
        server_handlers["cae.simulation"] = recording
        app = FastAPI()
        ended_connections = asyncio.Queue()

        @app.websocket("/jobs/{job_id}")
        async def stream(websocket: WebSocket, job_id: str):
            try:
                await worker_connection.run_worker_connection(websocket, job_id)
            finally:
                ended_connections.put_nowait(None)

        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        url = f"ws://127.0.0.1:{listener.getsockname()[1]}/jobs/{job.id}"
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
        try:
            idle_timeout = 0.3 if scenario in {"continuous_chunks", "idle"} else 180
            with patch.object(worker_connection, "SessionLocal", sessions), patch.object(
                worker_connection, "WORKER_IDLE_TIMEOUT_SECONDS", idle_timeout,
            ):
                server_task = asyncio.create_task(server.serve(sockets=[listener]))
                while not server.started:
                    await asyncio.sleep(0.01)
                headers = {"Authorization": f"Bearer {assignment['token']}"}
                async with websockets.connect(url, additional_headers=headers) as first:
                    ready = {"type": "job.ready", **execution_identity(job)}
                    if scenario == "stale_attempt":
                        async with sessions() as db:
                            current = await db.get(Job, job.id)
                            current.attempt_count = 2
                            current.attempt_id = str(uuid.uuid4())
                            current.instance_id = str(uuid.uuid4())
                            current.reservation_id = str(uuid.uuid4())
                            await sync_attempt(db, current)
                            replacement = await worker_connection.worker_assignment(db, current)
                            replacement_identity = execution_identity(current)
                        await runtime.mark_instance(launcher.id, {**replacement_identity, "state": "starting", "slave_app_id": "cae"})
                        await send_packet(first.send, first.send, ready)
                        rejection, _ = await receive_packet(first.recv)
                        self.assertEqual(rejection["type"], "job.cancel")
                        await first.wait_closed()
                        with self.assertRaises(websockets.exceptions.InvalidStatus) as denied:
                            async with websockets.connect(url, additional_headers=headers):
                                self.fail("The old attempt token was accepted.")
                        self.assertEqual(denied.exception.response.status_code, 403)
                        async with sessions() as db:
                            current = await db.get(Job, job.id)
                            self.assertEqual((current.state, current.attempt_count), ("assigned", 2))
                        headers = {"Authorization": f"Bearer {replacement['token']}"}
                        async with websockets.connect(url, additional_headers=headers) as replacement_socket:
                            await send_packet(replacement_socket.send, replacement_socket.send,
                                              {"type": "job.ready", **replacement_identity})
                            packet, _ = await receive_packet(replacement_socket.recv)
                            self.assertEqual(packet["type"], "job.input")
                            await send_packet(replacement_socket.send, replacement_socket.send,
                                              {"type": "job.record", "sequence": 1, "name": "result",
                                               "value": box_tensor(), **replacement_identity})
                            acknowledgement, _ = await receive_packet(replacement_socket.recv)
                            self.assertEqual(acknowledgement["type"], "job.record.ack")
                            await send_packet(replacement_socket.send, replacement_socket.send,
                                              {"type": "job.complete", "recordSequences": [1], "visualizationSequences": [], **replacement_identity})
                            acknowledgement, _ = await receive_packet(replacement_socket.recv)
                            self.assertEqual(acknowledgement["type"], "job.complete.ack")
                        async with sessions() as db:
                            self.assertEqual((await db.get(Job, job.id)).state, "succeeded")
                        return

                    second = None
                    if scenario == "duplicate":
                        second = await websockets.connect(url, additional_headers=headers)
                    await send_packet(first.send, first.send, ready)
                    packet, _ = await receive_packet(first.recv)
                    self.assertEqual(packet["type"], "job.input")
                    if second is not None:
                        try:
                            await send_packet(second.send, second.send, ready)
                            rejection, _ = await receive_packet(second.recv)
                            self.assertEqual(rejection["type"], "job.cancel")
                            await second.wait_closed()
                        finally:
                            await second.close()
                    async with sessions() as db:
                        self.assertEqual((await db.get(Job, job.id)).state, "running")

                    if scenario == "idle":
                        rejection, _ = await asyncio.wait_for(receive_packet(first.recv), timeout=3)
                        self.assertEqual(rejection["type"], "job.cancel")
                    else:
                        async def send_record_bytes(data):
                            if scenario == "continuous_chunks":
                                for offset in range(0, len(data), 16):
                                    await asyncio.sleep(0.1)
                                    await first.send(data[offset:offset + 16])
                            else:
                                await first.send(data)

                        if scenario == "continuous_chunks":
                            async with sessions() as db:
                                current = await db.get(Job, job.id)
                                current.updated_at = utcnow() - timedelta(minutes=4)
                                await db.commit()
                                self.assertEqual(await JobService.expire_stale_jobs(db), [])
                                await db.refresh(current)
                                self.assertEqual(current.state, "running")
                        upload_started = asyncio.get_running_loop().time()
                        await send_packet(first.send, send_record_bytes, {
                            "type": "job.record", **execution_identity(job), "sequence": 1, "name": "result",
                            "value": box_tensor(),
                        })
                        if scenario == "continuous_chunks":
                            elapsed = asyncio.get_running_loop().time() - upload_started
                            self.assertGreater(elapsed, idle_timeout * 2)
                        acknowledgement, _ = await receive_packet(first.recv)
                        self.assertEqual(acknowledgement, {"type": "job.record.ack", "sequence": 1, **execution_identity(job)})
                        async with sessions() as db:
                            self.assertEqual(await db.scalar(select(func.count()).select_from(JobRecord)), 1)
                            self.assertEqual(await db.scalar(select(func.count()).select_from(RecordedData)), 0)
                            if scenario == "cancel_before_complete":
                                _, cancellations = await cancel_batch(db, batch.id, owner)
                                self.assertEqual(cancellations, [execution_identity(job)])

                    if scenario in {"cancel_before_complete", "disconnect_after_staging", "idle"}:
                        if scenario == "cancel_before_complete":
                            await send_packet(first.send, first.send, {"type": "job.complete", "recordSequences": [1], "visualizationSequences": [], **execution_identity(job)})
                            rejection, _ = await receive_packet(first.recv)
                            self.assertEqual(rejection["type"], "job.cancel")
                        await first.close()
                        await asyncio.wait_for(ended_connections.get(), timeout=3)
                        async with sessions() as db:
                            current = await db.get(Job, job.id)
                            self.assertEqual(current.state, "cancelled" if scenario == "cancel_before_complete" else "failed")
                            self.assertIsNone((await db.get(Measurement, measurement.id)).recorded_at)
                            self.assertEqual(await db.scalar(select(func.count()).select_from(RecordedData)), 0)
                            self.assertEqual(await db.scalar(select(func.count()).select_from(JobRecord)), 0)
                            self.assertTrue(await runtime.launcher_matches_job(launcher.id, job.id))
                            await worker_connection.worker_cleaned(db, identity=execution_identity(job), user_id=owner)
                            self.assertFalse(await runtime.launcher_matches_job(launcher.id, job.id))
                        return

                    await send_packet(first.send, first.send, {"type": "job.complete", "recordSequences": [1], "visualizationSequences": [], **execution_identity(job)})
                    acknowledgement, _ = await receive_packet(first.recv)
                    self.assertEqual(acknowledgement["type"], "job.complete.ack")
                async with sessions() as db:
                    self.assertEqual((await db.get(Job, job.id)).state, "succeeded")
        finally:
            server.should_exit = True
            if "server_task" in locals():
                await server_task
            listener.close()
            await runtime.remove_launcher(launcher.id)
            await engine.dispose()

    def test_real_solver_records_without_a_browser(self):
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        asyncio.run(_create_database(database))
        try:
            _upgrade(database, "head")
            asyncio.run(self._verify(database))
        finally:
            asyncio.run(_drop_database(database))

    async def _verify(self, database):
        from cae_parallel_fixture import verify_parallel_execution
        await verify_parallel_execution(self, database)
