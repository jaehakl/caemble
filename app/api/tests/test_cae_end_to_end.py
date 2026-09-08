"""Opt-in public CLI build, real CAE child, WebSocket, and PostgreSQL integration."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import socket
import subprocess
import tempfile
import sys
import unittest
import uuid
from contextlib import suppress
from datetime import timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from caemble_catalog import Catalog
from fastapi import FastAPI, WebSocket
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
import numpy as np
import uvicorn
import websockets

from cae import recording
from cae.batches import cancel_batch, create_batch
from cae.models import BatchCreateRequest
from cae.uploads import CHUNK_BYTES, commit_batch, finalize_item, upload_chunk
from models import RoleEnum, UserData
from service.data_tools import slice_recorded_tensor
from cae.db import CaeBatch
from db import Experiment, ExperimentRecord, Measurement, RecordedData, make_async_db_url
from gpstation.db import Job, JobBatch, JobEvent, JobRecord, Launcher
from gpstation.service import worker_connection
from gpstation.service.job_service import JobService
from gpstation.service.server_handlers import server_handlers
from gpstation.service.state import runtime, utcnow
from sdk.protocol.packets import receive_packet, send_packet
from test_calculation_database import _create_database, _database_url, _drop_database, _seed_owners, _upgrade


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
                                job_modes={"cae": "websocket"}, status="busy", connected_at=utcnow(), last_heartbeat_at=utcnow())
            db.add_all([batch, launcher])
            await db.flush()
            db.add(CaeBatch(batch_id=batch.id, experiment_id=experiment_id, spec={"mode": "generate"}))
            schema = {"dtype": "float64", "tensorOrder": 0}
            job = Job(user_id=owner, launcher_id=launcher.id, handler_type="cae.simulation", slave_app_id="cae",
                      job_mode="websocket", batch_id=batch.id, item_index=1, state="assigned", attempt_count=1,
                      input={"measurement": {"experiment": {"simulationProgram": {"recordedData": {"result": schema}}}}})
            db.add(job)
            await db.flush()
            measurement = Measurement(user_id=owner, experiment_id=experiment_id, job_id=job.id,
                                      vars={}, material_snapshot={})
            db.add(measurement)
            db.add(ExperimentRecord(experiment_id=experiment_id, name="result", tensor_order=0,
                                    dtype="float64", data_schema=schema, contract_hash="transport-test"))
            await db.commit()
            assignment = await worker_connection.worker_assignment(db, job)
        await runtime.register_launcher(launcher.id, AsyncMock(), "test-key")
        await runtime.mark_launcher_job(launcher.id, job.id)
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
                    ready = {"type": "job.ready", "job_id": job.id, "attempt_count": 1}
                    if scenario == "stale_attempt":
                        async with sessions() as db:
                            current = await db.get(Job, job.id)
                            current.attempt_count = 2
                            replacement = await worker_connection.worker_assignment(db, current)
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
                                              {**ready, "attempt_count": 2})
                            packet, _ = await receive_packet(replacement_socket.recv)
                            self.assertEqual(packet["type"], "job.input")
                            await send_packet(replacement_socket.send, replacement_socket.send,
                                              {"type": "job.complete", "recordSequences": []})
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
                            "type": "job.record", "sequence": 1, "name": "result",
                            "value": {"shape": [], "storage": {"kind": "inline", "value": 2.5}},
                        })
                        if scenario == "continuous_chunks":
                            elapsed = asyncio.get_running_loop().time() - upload_started
                            self.assertGreater(elapsed, idle_timeout * 2)
                        acknowledgement, _ = await receive_packet(first.recv)
                        self.assertEqual(acknowledgement, {"type": "job.record.ack", "sequence": 1})
                        async with sessions() as db:
                            self.assertEqual(await db.scalar(select(func.count()).select_from(JobRecord)), 1)
                            self.assertEqual(await db.scalar(select(func.count()).select_from(RecordedData)), 0)
                            if scenario == "cancel_before_complete":
                                _, cancellations = await cancel_batch(db, batch.id, owner)
                                self.assertEqual(cancellations, [(launcher.id, job.id)])

                    if scenario in {"cancel_before_complete", "disconnect_after_staging", "idle"}:
                        if scenario == "cancel_before_complete":
                            await send_packet(first.send, first.send, {"type": "job.complete", "recordSequences": [1]})
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
                            await worker_connection.worker_cleaned(db, job_id=job.id, attempt_count=1,
                                                                  launcher_id=launcher.id, user_id=owner)
                            self.assertFalse(await runtime.launcher_matches_job(launcher.id, job.id))
                        return

                    await send_packet(first.send, first.send, {"type": "job.complete", "recordSequences": [1]})
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
        owner, _, experiment_id, _ = await _seed_owners(database)
        catalog = Catalog.open_readonly()
        try:
            example = catalog.experiment("electro-thermal-notched-bar")
            repo = Path(__file__).resolve().parents[3]
            cae = repo / "app" / "slaves" / "cae"
            python = os.getenv("CAE_PYTHON") or subprocess.check_output(
                ["poetry", "env", "info", "--executable"], cwd=cae, text=True,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            ).strip()
            with tempfile.TemporaryDirectory(prefix="caemble-client-build-") as directory:
                result = await asyncio.to_thread(subprocess.run, [
                    "node", str(repo / "app/ui/dist-cli/caemble.cjs"), "--repo", str(repo),
                    "--python", python, "experiment", "build", "--example", "electro-thermal-notched-bar",
                    "--vars-mode", "nominal", "--out", directory,
                ], cwd=repo, capture_output=True, text=True, encoding="utf-8", timeout=180)
                self.assertEqual(result.returncode, 0, result.stderr)
                manifest = json.loads((Path(directory) / "manifest.json").read_text(encoding="utf-8"))
                artifact_bytes = (Path(directory) / manifest["items"][0]["file"]).read_bytes()
                prepared = json.loads(artifact_bytes)
                local_directory = Path(directory) / "local-results"
                local_process = await asyncio.to_thread(subprocess.run, [
                    "node", str(repo / "app/ui/dist-cli/caemble.cjs"), "--repo", str(repo),
                    "--python", python, "experiment", "test", directory, "--out", str(local_directory),
                ], cwd=repo, capture_output=True, text=True, encoding="utf-8", timeout=180)
                self.assertEqual(local_process.returncode, 0, local_process.stderr)
                local_manifest = json.loads((local_directory / "1/manifest.json").read_text(encoding="utf-8"))
                self.assertEqual(local_manifest["state"], "succeeded")
                self.assertEqual(local_manifest["inputHash"], manifest["items"][0]["input_hash"])
                self.assertEqual(hashlib.sha256(artifact_bytes).hexdigest(), local_manifest["inputHash"])
                local_records = {}
                for local_record in local_manifest["records"]:
                    payload = json.loads((local_directory / "1" / local_record["path"]).read_text(encoding="utf-8"))
                    attachments = {item["id"]: (local_directory / "1" / item["path"]).read_bytes()
                                   for item in local_record["attachments"]}
                    persisted = recording.persist_record(local_record["schema"], payload["value"], attachments)
                    pending = [(local_record["name"], local_record["schema"], persisted)]
                    while pending:
                        name, schema, tensor = pending.pop()
                        if "dtype" in schema:
                            local_records[name] = (schema, tensor)
                        else:
                            pending.extend((f"{name}.{key}", member, tensor[key]) for key, member in schema.items())

        finally:
            catalog.close()
        measurement_input = prepared["measurement"]
        schemas = measurement_input["experiment"]["simulationProgram"]["recordedData"]
        self.assertGreater(len(measurement_input["experiment"]["simulationProgram"]["tasks"]), 0)
        engine = create_async_engine(make_async_db_url(_database_url(database)))
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as db:
            experiment = await db.get(Experiment, experiment_id)
            experiment.source_bundle = example["sourceBundle"]
            experiment.source_hash = example["bundleHash"]
            launcher = Launcher(user_id=owner, launcher_name="real-cae-process", slave_app_ids=["cae"],
                                job_modes={"cae": "websocket"}, status="ready", connected_at=utcnow(), last_heartbeat_at=utcnow())
            db.add(launcher)
            leaves = list(schemas.items())
            expected_names = set()
            while leaves:
                name, schema = leaves.pop()
                if "dtype" not in schema:
                    leaves.extend((f"{name}.{member}", value) for member, value in schema.items())
                    continue
                expected_names.add(name)
                db.add(ExperimentRecord(experiment_id=experiment_id, name=name, tensor_order=schema.get("tensorOrder", 0),
                                        dtype=schema["dtype"], quantity_kind=schema.get("quantityKind"), data_schema=schema,
                                        contract_hash="real-cae-test"))
            await db.commit()
            user = UserData(id=owner, roles=[RoleEnum.user])
            with Catalog.open_readonly() as current_catalog:
                batch = await create_batch(db, BatchCreateRequest(
                    request_id=uuid.uuid4(), experiment_id=experiment_id,
                    experiment_source_hash=example["bundleHash"], mode="generate",
                    catalog_revision=manifest["catalog_revision"], builder_version="2",
                    items=[{"index": 1, "input_hash": hashlib.sha256(artifact_bytes).hexdigest(),
                            "byte_length": len(artifact_bytes)}],
                ), user, current_catalog)
                for index, start in enumerate(range(0, len(artifact_bytes), CHUNK_BYTES)):
                    chunk = artifact_bytes[start:start + CHUNK_BYTES]
                    await upload_chunk(db, batch.id, owner, 1, index, hashlib.sha256(chunk).hexdigest(), chunk)
                await finalize_item(db, batch.id, owner, 1)
                await commit_batch(db, batch.id, user, current_catalog)
            job, _ = await JobService.claim_next_compatible_job(db, idle_launcher_ids={launcher.id})
            measurement = await db.scalar(select(Measurement).where(Measurement.job_id == job.id))
            assignment = await worker_connection.worker_assignment(db, job)
        await runtime.register_launcher(launcher.id, AsyncMock(), "test-key")
        await runtime.mark_launcher_job(launcher.id, job.id)
        server_handlers["cae.simulation"] = recording
        app = FastAPI()

        @app.websocket("/jobs/{job_id}")
        async def stream(websocket: WebSocket, job_id: str):
            await worker_connection.run_worker_connection(websocket, job_id)

        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        assignment["websocket_url"] = f"ws://127.0.0.1:{listener.getsockname()[1]}/jobs/{job.id}"
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
        cae = Path(__file__).resolve().parents[2] / "slaves" / "cae"
        process = None
        stderr_task = None
        events = []
        try:
            with patch.object(worker_connection, "SessionLocal", sessions):
                server_task = asyncio.create_task(server.serve(sockets=[listener]))
                while not server.started:
                    await asyncio.sleep(0.01)
                process = await asyncio.create_subprocess_exec(
                    str(python), "-m", "app", "--worker", cwd=cae,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
                )
                stderr_task = asyncio.create_task(process.stderr.read())
                ready = json.loads(await asyncio.wait_for(process.stdout.readline(), timeout=30))
                self.assertEqual(ready, {"type": "worker.ready"})
                process.stdin.write((json.dumps(assignment) + "\n").encode("utf-8"))
                await process.stdin.drain()
                async with asyncio.timeout(120):
                    while True:
                        line = await process.stdout.readline()
                        if not line:
                            self.fail(f"CAE process exited: {(await stderr_task).decode('utf-8', errors='replace')}")
                        event = json.loads(line)
                        events.append(event)
                        if event["type"] == "job.cleaned":
                            break
                self.assertEqual(events, [{"type": "job.cleaned", "job_id": job.id, "attempt_count": 1}])
                async with sessions() as db:
                    stored_job = await db.get(Job, job.id)
                    self.assertEqual(stored_job.state, "succeeded", stored_job.last_error)
                    self.assertIsNotNone((await db.get(Measurement, measurement.id)).recorded_at)
                    names = set((await db.scalars(select(ExperimentRecord.name).join(RecordedData)
                                                 .where(RecordedData.measurement_id == measurement.id))).all())
                    self.assertEqual(names, expected_names)
                    self.assertEqual(names, set(local_records))
                    self.assertEqual(stored_job.artifact_metadata["input_hash"], local_manifest["inputHash"])
                    self.assertEqual(stored_job.input["measurement"], measurement_input)
                    rows = (await db.execute(select(RecordedData, ExperimentRecord).join(
                        ExperimentRecord, ExperimentRecord.id == RecordedData.experiment_record_id
                    ).where(RecordedData.measurement_id == measurement.id))).all()
                    for remote_data, record in rows:
                        schema, local_tensor = local_records[record.name]
                        self.assertEqual(record.data_schema, schema)
                        self.assertEqual(record.dtype, schema["dtype"])
                        self.assertEqual(remote_data.data["shape"], local_tensor["shape"])
                        self.assertEqual(remote_data.data.get("axes"), local_tensor.get("axes"))
                        offset = 0
                        while True:
                            local_slice = slice_recorded_tensor(local_tensor, record.dtype, offset, 10000)
                            remote_slice = slice_recorded_tensor(remote_data.data, record.dtype, offset, 10000)
                            if record.dtype == "string":
                                self.assertEqual(remote_slice["values"], local_slice["values"])
                            else:
                                # Use the existing numerical-test default allclose tolerance.
                                np.testing.assert_allclose(remote_slice["values"], local_slice["values"], err_msg=record.name)
                            if local_slice["nextOffset"] is None:
                                break
                            offset = local_slice["nextOffset"]

                    self.assertEqual(await db.scalar(select(func.count()).select_from(JobRecord)), 0)
                    self.assertEqual((await db.get(JobBatch, batch.id)).succeeded, 1)
                    kinds = list((await db.scalars(select(JobEvent.type).order_by(JobEvent.id))).all())
                    self.assertEqual(kinds[-2:], ["job.succeeded", "batch.completed"])
                    self.assertTrue(await worker_connection.worker_cleaned(db, job_id=job.id, attempt_count=1,
                                                                          launcher_id=launcher.id, user_id=owner))
                    self.assertFalse(await runtime.launcher_matches_job(launcher.id, job.id))
        finally:
            if process is not None and process.returncode is None:
                with suppress(BrokenPipeError, ConnectionResetError):
                    process.stdin.write(b'{"type":"stop"}\n')
                    await process.stdin.drain()
                try:
                    await asyncio.wait_for(process.wait(), timeout=10)
                except TimeoutError:
                    process.kill()
                    await process.wait()
            if stderr_task is not None:
                await stderr_task
            server.should_exit = True
            if "server_task" in locals():
                await server_task
            listener.close()
            await runtime.remove_launcher(launcher.id)
            await engine.dispose()
