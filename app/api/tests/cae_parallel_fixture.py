"""One small real Batch: public build, real launcher, worker streams and PostgreSQL."""
from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import os
import re
from pathlib import Path
import socket
import tempfile
import uuid
from contextlib import ExitStack, suppress
from unittest.mock import patch

import numpy as np
import psutil
from caemble_catalog import Catalog
from fastapi import FastAPI, WebSocket
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
import uvicorn

from simulation.services import recording
from simulation.services.batches import create_batch
from simulation.schemas import BatchCreateRequest
from simulation.services.uploads import CHUNK_BYTES, commit_batch, finalize_item, upload_chunk
from simulation.db import Experiment, ExperimentRecord, Measurement, RecordedData
from db import make_async_db_url
from gpstation.db import APIKey, ExecutionAttempt, Job, JobBatch, JobRecord
from gpstation.service import launcher_connection, worker_connection
from gpstation.service.job_orchestrator import JobOrchestrator
from gpstation.service.server_handlers import server_handlers
from gpstation.service.state import runtime
from user_auth.schemas import RoleEnum, UserData
from core.data_tools import slice_recorded_tensor
from settings import settings
from test_calculation_database import _database_url, _seed_owners
from user_auth.utils.auth_utils import hash_token
from user_auth.db import Role, UserRole


async def verify_parallel_execution(test, database: str) -> None:
    repo = Path(__file__).resolve().parents[3]
    suffix = Path("Scripts/python.exe" if os.name == "nt" else "bin/python")
    cae_python = Path(os.getenv("CAE_PYTHON", str(repo / "app/slaves/cae/.venv" / suffix)))
    launcher_python = repo / "app/launcher/.venv" / suffix
    owner, _, experiment_id, _ = await _seed_owners(database)
    engine = create_async_engine(make_async_db_url(_database_url(database)))
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    orchestrator = JobOrchestrator(runtime)
    orchestrator_module = importlib.import_module("gpstation.service.job_orchestrator")
    launcher_logs: list[str] = []
    solver_starts: dict[tuple[str, str], float] = {}
    solver_intervals: dict[str, list[tuple[float, float]]] = {}
    process = None
    log_task = None
    server_task = None
    launcher_id = None
    observed_pids: set[tuple[int, float]] = set()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    base_url = f"http://127.0.0.1:{listener.getsockname()[1]}"
    app = FastAPI()

    @app.websocket("/v1/launchers/control")
    async def control(websocket: WebSocket):
        await launcher_connection.run_launcher_control(websocket)

    @app.websocket("/v1/jobs/{job_id}/stream")
    async def stream(websocket: WebSocket, job_id: str):
        await worker_connection.run_worker_connection(websocket, job_id)

    server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
    server_handlers["cae.simulation"] = recording
    temporary_directory = tempfile.TemporaryDirectory(prefix="caemble-parallel-")
    patches = ExitStack()
    log_file = (repo / ".work" / "resource-parallel-launcher.log").open("w", encoding="utf-8")
    try:
        temporary = Path(temporary_directory.name)
        artifact = temporary / "artifact"
        build = await asyncio.create_subprocess_exec(
            "node", str(repo / "app/ui/dist-cli/caemble.cjs"), "--repo", str(repo),
            "--python", str(cae_python), "experiment", "build", "--example", "electro-thermal-notched-bar",
            "--vars-mode", "nominal", "--out", str(artifact), cwd=repo,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        build_out, build_error = await asyncio.wait_for(build.communicate(), 180)
        test.assertEqual(build.returncode, 0, build_error.decode("utf-8", errors="replace"))
        manifest = json.loads((artifact / "manifest.json").read_text(encoding="utf-8"))
        data = (artifact / manifest["items"][0]["file"]).read_bytes()
        prepared = json.loads(data)
        input_hash = hashlib.sha256(data).hexdigest()
        program = prepared["measurement"]["experiment"]["simulationProgram"]
        with Catalog.open_readonly() as catalog:
            example = catalog.experiment("electro-thermal-notched-bar")
        token = f"parallel-{uuid.uuid4().hex}"
        async with sessions() as db:
            role = await db.scalar(select(Role).where(Role.name == "user"))
            if role is None:
                role = Role(name="user")
                db.add(role)
                await db.flush()
            db.add(UserRole(user_id=owner, role_id=role.id))
            experiment = await db.get(Experiment, experiment_id)
            experiment.source_bundle = example["sourceBundle"]
            experiment.source_hash = example["bundleHash"]
            experiment.result_contracts = program["resultContracts"]
            pending = list(program["recordedData"].items())
            expected_names = set()
            while pending:
                name, schema = pending.pop()
                if "dtype" not in schema:
                    pending.extend((f"{name}.{key}", member) for key, member in schema.items())
                    continue
                expected_names.add(name)
                db.add(ExperimentRecord(experiment_id=experiment_id, name=name,
                    tensor_order=schema.get("tensorOrder", 0), dtype=schema["dtype"],
                    quantity_kind=schema.get("quantityKind"), data_schema=schema, contract_hash="parallel-test"))
            db.add(APIKey(user_id=owner, name="parallel-test", key_prefix=uuid.uuid4().hex,
                          key_hash=hash_token(token), scopes=["launcher"]))
            await db.commit()

        async def submit(count: int):
            user = UserData(id=owner, roles=[RoleEnum.user])
            async with sessions() as db:
                with Catalog.open_readonly() as catalog:
                    batch = await create_batch(db, BatchCreateRequest(
                        request_id=uuid.uuid4(), experiment_id=experiment_id,
                        experiment_source_hash=example["bundleHash"], mode="generate",
                        catalog_revision=manifest["catalog_revision"], builder_version="2",
                        resources={"cpu_cores": 1, "gpu_count": 0},
                        items=[{"index": index, "input_hash": input_hash, "byte_length": len(data)}
                               for index in range(1, count + 1)],
                    ), user, catalog)
                    for item in range(1, count + 1):
                        for chunk_index, start in enumerate(range(0, len(data), CHUNK_BYTES)):
                            chunk = data[start:start + CHUNK_BYTES]
                            await upload_chunk(db, batch.id, owner, item, chunk_index, hashlib.sha256(chunk).hexdigest(), chunk)
                        await finalize_item(db, batch.id, owner, item)
                    test.assertEqual(await db.scalar(select(func.count()).select_from(Job).where(
                        Job.batch_id == batch.id, Job.state != "staged")), 0)
                    await commit_batch(db, batch.id, user, catalog)
                    batch_id = batch.id
            orchestrator.wake_dispatcher()
            return batch_id

        async def wait_completed(batch_id):
            async with asyncio.timeout(120):
                while True:
                    async with sessions() as db:
                        jobs = list((await db.scalars(select(Job).where(Job.batch_id == batch_id).order_by(Job.item_index))).all())
                        failed = [job for job in jobs if job.state in {"failed", "cancelled", "killed"}]
                        test.assertFalse(failed, f"{[(job.state, job.last_error) for job in failed]}\n{''.join(launcher_logs)[-6000:]}")
                        if jobs and all(job.state == "succeeded" and job.cleaned_at for job in jobs):
                            return jobs
                    if process.returncode is not None:
                        test.fail(f"Launcher exited: {''.join(launcher_logs)[-6000:]}")
                    with suppress(psutil.NoSuchProcess):
                        observed_pids.update((child.pid, child.create_time())
                            for child in psutil.Process(process.pid).children(recursive=True)
                            if child.cmdline()[-2:] != ["-m", "app"])
                    await asyncio.sleep(0.05)

        for module in (launcher_connection, worker_connection, orchestrator_module):
            patches.enter_context(patch.object(module, "SessionLocal", sessions))
        patches.enter_context(patch.object(launcher_connection, "job_orchestrator", orchestrator))
        patches.enter_context(patch.object(settings, "public_api_base_url", base_url))
        server_task = asyncio.create_task(server.serve(sockets=[listener]))
        while not server.started:
            await asyncio.sleep(0.01)
        await orchestrator.start_dispatcher()
        resources_path = temporary / "resources.toml"
        resources_path.write_text('cpu_cores = 2\n[defaults.cae]\ncpu_cores = 1\ngpu_count = 0\n', encoding="utf-8")
        environment = {**os.environ, "CAEMBLE_API_URL": base_url, "CAEMBLE_ACCESS_TOKEN": token,
            "CAEMBLE_LAUNCHER_NAME": "parallel-acceptance", "CAEMBLE_RESOURCES_FILE": str(resources_path),
            "CAEMBLE_LAUNCHER_STATE_DIR": str(temporary / "launcher-state"),
            "CAEMBLE_HEARTBEAT_INTERVAL_SECONDS": "0.2", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        environment.pop("PYTHONPATH", None)
        process = await asyncio.create_subprocess_exec(str(launcher_python), "-m", "app", cwd=repo / "app/launcher",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=environment)

        async def capture_logs():
            while line := await process.stdout.readline():
                decoded = line.decode("utf-8", errors="replace")
                launcher_logs.append(decoded)
                lifecycle = re.match(r"\[[^ ]+ ([^ ]+) attempt=\d+\] solver child (started|cleanup complete) locator=\S+ pid=(\d+)", decoded)
                if lifecycle:
                    job_id, event, pid = lifecycle.groups()
                    observed_at = asyncio.get_running_loop().time()
                    if event == "started":
                        solver_starts[job_id, pid] = observed_at
                    elif (job_id, pid) in solver_starts:
                        solver_intervals.setdefault(job_id, []).append((solver_starts.pop((job_id, pid)), observed_at))
                log_file.write(decoded)
                log_file.flush()
        log_task = asyncio.create_task(capture_logs())
        print("Running sequential baseline through the launcher", flush=True)
        sequential_id = await submit(1)
        sequential = await wait_completed(sequential_id)
        launcher_id = sequential[0].launcher_id
        print("Running two parallel Jobs through the same launcher", flush=True)
        parallel_id = await submit(2)
        parallel = await wait_completed(parallel_id)
        test.assertEqual({job.launcher_id for job in parallel}, {launcher_id})
        test.assertLess(max(job.started_at for job in parallel), min(job.finished_at for job in parallel),
                        "The real worker execution intervals did not overlap")
        test.assertTrue(any(max(first[0], second[0]) < min(first[1], second[1])
            for first in solver_intervals.get(parallel[0].id, [])
            for second in solver_intervals.get(parallel[1].id, [])),
            "The actual Solver child execution intervals did not overlap")
        all_jobs = sequential + parallel
        test.assertEqual(len({job.attempt_id for job in all_jobs}), 3)
        test.assertEqual(len({job.instance_id for job in all_jobs}), 3)
        test.assertEqual(len({tuple(job.allocation["cpu_ids"]) for job in parallel}), 2)
        baseline = {}
        measurement_ids = set()
        async with sessions() as db:
            for job in all_jobs:
                test.assertEqual(job.attempt_count, 1)
                test.assertEqual(job.artifact_metadata["input_hash"], input_hash)
                test.assertEqual(job.input["measurement"], prepared["measurement"])
                attempt = await db.get(ExecutionAttempt, job.attempt_id)
                test.assertIsNotNone(attempt.cleaned_at)
                test.assertEqual(attempt.instance_id, job.instance_id)
                measurement = await db.scalar(select(Measurement).where(Measurement.job_id == job.id))
                measurement_ids.add(measurement.id)
                test.assertIsNotNone(measurement.recorded_at)
                rows = (await db.execute(select(RecordedData, ExperimentRecord).join(ExperimentRecord,
                    ExperimentRecord.id == RecordedData.experiment_record_id).where(RecordedData.measurement_id == measurement.id))).all()
                test.assertEqual({record.name for _, record in rows}, expected_names)
                for recorded, record in rows:
                    if job.id == sequential[0].id:
                        baseline[record.name] = recorded.data
                        continue
                    reference = baseline[record.name]
                    test.assertEqual(recorded.data["shape"], reference["shape"])
                    test.assertEqual(recorded.data.get("axes"), reference.get("axes"))
                    offset = 0
                    while True:
                        expected = slice_recorded_tensor(reference, record.dtype, offset, 10000)
                        actual = slice_recorded_tensor(recorded.data, record.dtype, offset, 10000)
                        if record.dtype == "string":
                            test.assertEqual(actual["values"], expected["values"])
                        else:
                            np.testing.assert_allclose(actual["values"], expected["values"], rtol=1e-7, atol=0, err_msg=record.name)
                        if expected["nextOffset"] is None:
                            break
                        offset = expected["nextOffset"]
            test.assertEqual(len(measurement_ids), 3)
            test.assertEqual(await db.scalar(select(func.count()).select_from(JobRecord)), 0)
            test.assertEqual((await db.get(JobBatch, parallel_id)).succeeded, 2)
        async with asyncio.timeout(10):
            while True:
                state = await runtime.get_launcher(launcher_id)
                if state and not state.instances and state.resources.get("cpu_reserved") == 0:
                    break
                await asyncio.sleep(0.05)
        for pid, birth in observed_pids:
            with suppress(psutil.NoSuchProcess):
                test.assertNotEqual(psutil.Process(pid).create_time(), birth, f"Managed process {pid} survived cleanup")
        report = {"example": "electro-thermal-notched-bar", "solver_runs": 3,
            "launcher_id": launcher_id, "measurement_ids": sorted(measurement_ids), "rtol": 1e-7, "atol": 0,
            "solver_intervals_monotonic": solver_intervals, "cleanup_verified": True,
            "jobs": [{"id": job.id, "attempt_id": job.attempt_id, "instance_id": job.instance_id,
                      "cpu_ids": job.allocation["cpu_ids"], "started_at": job.started_at.isoformat(),
                      "finished_at": job.finished_at.isoformat(), "cleaned_at": job.cleaned_at.isoformat()} for job in all_jobs]}
        report_path = repo / ".work" / "resource-parallel-acceptance.json"
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    finally:
        await orchestrator.stop_dispatcher()
        if process is not None and process.returncode is None:
            # Windows virtualenv python.exe is a redirector; terminate its real
            # interpreter too so inherited stdout cannot keep the reader alive.
            with suppress(psutil.NoSuchProcess):
                owned = psutil.Process(process.pid).children(recursive=True)
                for child in reversed(owned):
                    with suppress(psutil.NoSuchProcess):
                        child.kill()
                psutil.Process(process.pid).kill()
            await asyncio.wait_for(process.wait(), 10)
        if log_task is not None:
            await asyncio.wait_for(log_task, 10)
        log_file.close()
        server.should_exit = True
        if server_task is not None:
            await server_task
        listener.close()
        if launcher_id:
            await runtime.remove_launcher(launcher_id)
        await engine.dispose()
        patches.close()
        temporary_directory.cleanup()
