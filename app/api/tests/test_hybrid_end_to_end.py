"""Opt-in real small kNN Hybrid Optimization through API, launcher and child processes."""
from __future__ import annotations

import asyncio
import base64
from contextlib import ExitStack, suppress
from datetime import datetime, timezone
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import socket
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from caemble_catalog import Catalog
from fastapi import FastAPI, Request, Response, WebSocket
import httpx
import psutil
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
import uvicorn

from simulation.services import recording
from optimization import controller, evaluation, integration, predictor_jobs
from optimization.predictor_router import router as predictor_router
from optimization.db import StageSubmission, Optimization, Trial, Evaluation, EvaluationSubmission
from optimization.router import authenticated, router
from calculation.db import Calculation, CalculationSource
from simulation.db import Experiment, ExperimentRecord, Measurement, RecordedData
from db import make_async_db_url
from gpstation.db import APIKey, Job, Launcher
from prediction import training
from prediction.db import DatasetGrant, ModelLease
from prediction.router import authenticated as prediction_authenticated, router as prediction_router
from gpstation.service import launcher_connection, worker_connection
from gpstation.service.job_orchestrator import JobOrchestrator
from gpstation.service.server_handlers import register_server_handler, server_handlers
from gpstation.service.state import runtime
from gpstation.utils.csrf import require_web_csrf
from user_auth.schemas import RoleEnum, UserData
from settings import settings
from test_calculation_database import _create_database, _database_url, _drop_database, _seed_owners, _upgrade
from user_auth.db import Role, UserRole
from db import get_db
from user_auth.utils.auth_utils import hash_token


def prediction_artifact(reference, objects):
    prefix = f"caemble/objects/{reference['id']}/"
    raw = b"".join(objects[key] for key in sorted(objects) if key.startswith(prefix))
    assert len(raw) == reference["byteLength"]
    assert hashlib.sha256(raw).hexdigest() == reference["sha256"]
    assert reference["encoding"] == "json"
    return json.loads(raw)


def recorded_current(tensor):
    # The example's totalCurrent is a single float64 BoxGrid value.
    assert tensor["shape"] == [1] * 7 and tensor["storage"]["kind"] == "inline"
    value = tensor["storage"]["value"]
    for _ in range(7):
        assert isinstance(value, list) and len(value) == 1
        value = value[0]
    assert type(value) in (float, int) and math.isfinite(value)
    return float(value)


async def stop_process_tree(process):
    """Reap only the fixture's own tree, including a timed-out CLI build."""
    if process is None or process.returncode is not None:
        return
    descendants = []
    with suppress(psutil.NoSuchProcess):
        descendants = psutil.Process(process.pid).children(recursive=True)
        for child in reversed(descendants):
            with suppress(psutil.NoSuchProcess):
                child.kill()
        psutil.Process(process.pid).kill()
    await asyncio.wait_for(process.wait(), 10)
    _, alive = await asyncio.to_thread(psutil.wait_procs, descendants, timeout=10)
    assert not alive, f"Fixture retained child processes: {[child.pid for child in alive]}"


@unittest.skipUnless(os.getenv("RUN_HYBRID_E2E") == "1", "Set RUN_HYBRID_E2E=1 for the small real Solver Optimization demo.")
class HybridEndToEndTests(unittest.TestCase):
    def test_fixed_knn_revision_selects_real_verified_candidates_without_browser(self):
        self.test_started = time.monotonic()
        report_dir = Path(__file__).resolve().parents[3] / ".work"
        report_dir.mkdir(exist_ok=True)
        self.report = {"status": "running", "phase": "database_setup", "budget_seconds": 180,
            "phase_seconds": {}, "cleanup_verified": False, "environment_cleanup_verified": False,
            "run_id": str(uuid.uuid4()), "started_at": datetime.now(timezone.utc).isoformat()}
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        created = False
        cleanup_error = None
        try:
            asyncio.run(_create_database(database))
            created = True
            _upgrade(database, "head")
            self.report["phase_seconds"]["database_setup"] = time.monotonic() - self.test_started
            asyncio.run(self.verify(database))
            self.report.update(status="passed", phase="complete")
        except BaseException as error:
            self.report.update(status="failed", error={"type": type(error).__name__, "message": str(error)})
            raise
        finally:
            cleanup_started = time.monotonic()
            if created:
                try:
                    asyncio.run(_drop_database(database))
                    self.report["database_cleanup_verified"] = True
                except BaseException as error:
                    cleanup_error = error
                    self.report.update(status="failed", database_cleanup_verified=False,
                        database_cleanup_error={"type": type(error).__name__, "message": str(error)})
            self.report["phase_seconds"]["database_teardown"] = time.monotonic() - cleanup_started
            self.report["total_test_seconds"] = time.monotonic() - self.test_started
            name = "hybrid-demo-acceptance.json" if self.report["status"] == "passed" else "hybrid-demo-last-failure.json"
            self.report_path = report_dir / name
            self.report_path.write_text(json.dumps(self.report, indent=2, allow_nan=False), encoding="utf-8")
            print(json.dumps({"status": self.report["status"], "report": str(self.report_path),
                "flow_seconds": self.report.get("flow_seconds"), "total_test_seconds": self.report["total_test_seconds"]}), flush=True)
            if cleanup_error is not None and sys.exc_info()[0] is None:
                raise cleanup_error

    async def verify(self, database):
        setup_started = time.monotonic()
        self.report["phase"] = "fixture_setup"
        repo = Path(__file__).resolve().parents[3]
        suffix = Path("Scripts/python.exe" if os.name == "nt" else "bin/python")
        cae_python = repo / "app/slaves/cae_simulation/.venv" / suffix
        launcher_python = repo / "app/launcher/.venv" / suffix
        owner, _, experiment_id, _ = await _seed_owners(database)
        engine = create_async_engine(make_async_db_url(_database_url(database)))
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        orchestrator = JobOrchestrator(runtime)
        orchestrator_module = importlib.import_module("gpstation.service.job_orchestrator")
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        base_url = f"http://127.0.0.1:{listener.getsockname()[1]}"
        app = FastAPI()
        app.include_router(router)
        app.include_router(predictor_router)
        app.include_router(prediction_router)
        user = UserData(id=owner, roles=[RoleEnum.user])
        app.dependency_overrides[authenticated] = lambda: user
        app.dependency_overrides[prediction_authenticated] = lambda: user
        app.dependency_overrides[require_web_csrf] = lambda: None

        async def test_db():
            async with sessions() as db:
                yield db

        app.dependency_overrides[get_db] = test_db
        objects: dict[str, bytes] = {}

        @app.put("/test-bucket/{key:path}")
        async def upload(key: str, request: Request):
            objects[key] = await request.body()
            return Response(status_code=200)

        @app.get("/test-bucket/{key:path}")
        async def download(key: str):
            return Response(objects[key], media_type="application/octet-stream")

        @app.websocket("/v1/launchers/control")
        async def control(websocket: WebSocket):
            await launcher_connection.run_launcher_control(websocket)

        @app.websocket("/v1/jobs/{job_id}/stream")
        async def stream(websocket: WebSocket, job_id: str):
            await worker_connection.run_worker_connection(websocket, job_id)

        def head(**kwargs):
            data = objects[kwargs["Key"]]
            return {"ContentLength": len(data), "ChecksumSHA256": base64.b64encode(hashlib.sha256(data).digest()).decode()}

        bucket = SimpleNamespace(
            generate_presigned_url=lambda operation, Params, ExpiresIn: f"{base_url}/test-bucket/{Params['Key']}",
            head_object=head,
            delete_objects=lambda **kwargs: None,
        )
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off", timeout_graceful_shutdown=10))
        catalog = Catalog.open_readonly()
        app.state.catalog = catalog
        temporary_directory = tempfile.TemporaryDirectory(prefix="caemble-hybrid-")
        patches = ExitStack()
        build = process = log_task = server_task = None
        optimization_id = None
        started = None
        flow_started = None
        flow_timeout = None
        phase_started = time.monotonic()
        self.report["phase"] = "example_build"
        launcher_ids = set()
        logs = []
        report_dir = repo / ".work"
        report_dir.mkdir(exist_ok=True)
        log_file = (report_dir / "hybrid-demo-launcher.log").open("w", encoding="utf-8")

        async def execution_report(status):
            async with sessions() as db:
                optimization = await db.get(Optimization, optimization_id) if optimization_id else None
                all_jobs = list((await db.scalars(select(Job).where(Job.user_id == owner).order_by(Job.created_at, Job.id))).all())
                launcher_ids.update(job.launcher_id for job in all_jobs if job.launcher_id)
                launcher_ids.update((await db.scalars(select(Launcher.id).where(Launcher.user_id == owner))).all())
                rows = (await db.execute(select(Trial, StageSubmission, Job)
                    .outerjoin(StageSubmission, StageSubmission.trial_id == Trial.id)
                    .outerjoin(Job, Job.id == StageSubmission.job_id).where(Trial.optimization_id == optimization_id)
                    .order_by(Trial.ordinal, StageSubmission.created_at))).all()
                return {"status": status, "optimization_id": optimization_id, "state": optimization.state if optimization else None,
                    "pause_reason": optimization.pause_reason if optimization else None,
                    "settings": optimization.settings if optimization else None,
                    "runtime_id": optimization.optimizer_state.get("runtime_id") if optimization else None,
                    "elapsed_seconds": self.report.get("phase_seconds", {}).get("hybrid"),
                    "budget_seconds": 180, "launcher_cpu_cores": 4, "cae_cpu_cores": 1,
                    "jobs": [{"id": job.id, "handler": job.handler_type, "state": job.state,
                        "optimization_id": (job.artifact_metadata or {}).get("optimization_id"),
                        "started_at": job.started_at.isoformat() if job.started_at else None,
                        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
                        "duration_seconds": (job.finished_at - job.started_at).total_seconds()
                            if job.finished_at and job.started_at else None,
                        "cleaned": job.cleaned_at is not None, "allocation": job.allocation,
                        "error": job.last_error} for job in all_jobs],
                    "training_solver_runs": sum(job.slave_app_id == "cae" and job.started_at is not None
                        and (job.artifact_metadata or {}).get("optimization_id") == self.report.get("training_optimization_id") for job in all_jobs),
                    "solver_runs": sum(job.slave_app_id == "cae" and job.started_at is not None
                        and (job.artifact_metadata or {}).get("optimization_id") == optimization_id for job in all_jobs),
                    "total_solver_runs": sum(job.slave_app_id == "cae" and job.started_at is not None for job in all_jobs),
                    "stages": [{"ordinal": trial.ordinal, "variables": trial.variables, "trial_state": trial.state,
                        "result": trial.result, "stage": submission.stage if submission else trial.next_stage,
                        "job_id": job.id if job else None, "job_state": job.state if job else None,
                        "started_at": job.started_at.isoformat() if job and job.started_at else None,
                        "finished_at": job.finished_at.isoformat() if job and job.finished_at else None,
                        "duration_seconds": (job.finished_at - job.started_at).total_seconds()
                            if job and job.started_at and job.finished_at else None,
                        "cleaned": job.cleaned_at is not None if job else None,
                        "allocation": job.allocation if job else None} for trial, submission, job in rows]}

        try:
            temporary = Path(temporary_directory.name)
            example = catalog.experiment("caemble:experiment/caemble/verified/hybrid-box-conductor@1.0.0")
            artifact_path = temporary / "artifact"
            build = await asyncio.create_subprocess_exec(
                "node", str(repo / "app/ui/dist-cli/caemble.cjs"), "--repo", str(repo), "--python", str(cae_python),
                "experiment", "build", "--example", example["coordinate"], "--vars-mode", "nominal", "--out", str(artifact_path),
                cwd=repo, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            _, error = await asyncio.wait_for(build.communicate(), 120)
            self.assertEqual(build.returncode, 0, error.decode("utf-8", errors="replace"))
            self.report["phase_seconds"]["example_build"] = time.monotonic() - phase_started
            self.report["phase"] = "launcher_setup"
            phase_started = time.monotonic()
            manifest = json.loads((artifact_path / "manifest.json").read_text(encoding="utf-8"))
            artifact = json.loads((artifact_path / manifest["items"][0]["file"]).read_text(encoding="utf-8"))
            built = artifact["measurement"]["experiment"]
            program = built["simulationProgram"]
            source = example["calculations"][0]["source_code"]
            token = f"hybrid-demo-{uuid.uuid4().hex}"
            async with sessions() as db:
                role = await db.scalar(select(Role).where(Role.name == "user"))
                db.add(UserRole(user_id=owner, role_id=role.id))
                experiment = await db.get(Experiment, experiment_id)
                experiment.source_bundle, experiment.source_hash = example["sourceBundle"], example["bundleHash"]
                experiment.result_contracts = program["resultContracts"]
                for name, schema in program["recordedData"].items():
                    db.add(ExperimentRecord(experiment_id=experiment_id, name=name, dtype=schema["dtype"],
                        tensor_order=schema.get("tensorOrder", 0), quantity_kind=schema.get("quantityKind"),
                        data_schema=schema, contract_hash=f"hybrid-demo-{name}"))
                calculation_source = CalculationSource(source_code=source, source_hash=hashlib.sha256(source.encode()).hexdigest(),
                                                       name="Current target error", owner_id=owner, revision=1)
                db.add(calculation_source)
                await db.flush()
                calculation = Calculation(experiment_id=experiment_id, source_id=calculation_source.id, contract_status="needs_preflight")
                db.add(calculation)
                db.add(APIKey(user_id=owner, name="hybrid-demo", key_prefix=uuid.uuid4().hex, key_hash=hash_token(token), scopes=["launcher"]))
                await db.commit()
                calculation_id = calculation.id
            for module in (launcher_connection, worker_connection, orchestrator_module, controller):
                patches.enter_context(patch.object(module, "SessionLocal", sessions))
            for module in (launcher_connection, orchestrator_module, controller, predictor_jobs):
                patches.enter_context(patch.object(module, "job_orchestrator", orchestrator))
            patches.enter_context(patch.object(settings, "public_api_base_url", base_url))
            patches.enter_context(patch.object(settings, "JWT_SECRET", uuid.uuid4().hex + uuid.uuid4().hex))
            patches.enter_context(patch("storage.service.bucket_client", return_value=bucket))
            patches.enter_context(patch.dict(server_handlers, clear=True))
            for name, implementation in (("cae.simulation", recording), ("cae.evaluation.build", evaluation), ("cae.evaluation.calculate", evaluation), ("cae.evaluation.predict", evaluation)):
                register_server_handler(name, implementation, event_context=integration.event_context, on_finished=integration.on_finished)
            register_server_handler(training.HANDLER, training, on_finished=training.on_finished)
            server_task = asyncio.create_task(server.serve(sockets=[listener]))
            while not server.started:
                await asyncio.sleep(0.01)
            await orchestrator.start_dispatcher()
            await controller.start_controller(catalog)
            resources = temporary / "resources.toml"
            resources.write_text('cpu_cores = 4\n[defaults.cae]\ncpu_cores = 1\ngpu_count = 0\n[defaults.evaluation]\ncpu_cores = 1\ngpu_count = 0\n[defaults.predictor]\ncpu_cores = 1\ngpu_count = 0\n[defaults.predictor-training]\ncpu_cores = 1\ngpu_count = 0\n', encoding="utf-8")
            environment = {**os.environ, "CAEMBLE_API_URL": base_url, "CAEMBLE_ACCESS_TOKEN": token,
                "CAEMBLE_LAUNCHER_NAME": "hybrid-acceptance", "CAEMBLE_PREDICTOR_STORAGE_ROOT": str(temporary / "predictor-storage"), "CAEMBLE_RESOURCES_FILE": str(resources),
                "CAEMBLE_LAUNCHER_STATE_DIR": str(temporary / "launcher-state"), "CAEMBLE_HEARTBEAT_INTERVAL_SECONDS": "0.2",
                "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
            environment.pop("PYTHONPATH", None)
            process = await asyncio.create_subprocess_exec(str(launcher_python), "-m", "app", cwd=repo / "app/launcher",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=environment)

            async def capture_logs():
                while line := await process.stdout.readline():
                    decoded = line.decode("utf-8", errors="replace")
                    logs.append(decoded)
                    log_file.write(decoded)
                    log_file.flush()

            log_task = asyncio.create_task(capture_logs())
            async with asyncio.timeout(60):
                while True:
                    self.assertIsNone(process.returncode, "Launcher exited.\n" + "".join(logs)[-6000:])
                    async with sessions() as db:
                        launcher = await db.scalar(select(Launcher).where(Launcher.user_id == owner))
                        if launcher is not None and launcher.status == "ready":
                            self.assertIn("predictor-training", launcher.slave_app_ids)
                            launcher_ids.add(launcher.id)
                            break
                    await asyncio.sleep(0.1)
            # Windows venv python.exe redirects to a persistent interpreter child.
            # Capture the idle launcher tree before it can receive any Jobs.
            launcher_processes = {(child.pid, child.create_time())
                for child in psutil.Process(process.pid).children(recursive=True)}
            self.report["launcher_bootstrap_processes"] = [list(identity) for identity in sorted(launcher_processes)]
            initial_vars = built["variables"]
            axes = []
            training_started = time.monotonic()
            self.report["phase_seconds"]["fixture_setup"] = training_started - setup_started
            flow_started = training_started
            phase_started = training_started
            self.report["phase"] = "training_solver"
            flow_timeout = asyncio.timeout_at(asyncio.get_running_loop().time() + 180)
            await flow_timeout.__aenter__()
            async with httpx.AsyncClient(base_url=base_url, timeout=30) as browser:
                response = await browser.post("/cae/optimizations", json={"request_id": str(uuid.uuid4()),
                    "experiment_id": experiment_id, "source_hash": example["bundleHash"], "vars_schema": built["varsSchema"],
                    "initial_vars": initial_vars, "axes": axes, "objective": {"calculation_id": calculation_id, "direction": "minimize"},
                    "max_trials": 3, "max_parallel": 2, "name": "Hybrid training data"})
                self.assertEqual(response.status_code, 200, response.text)
                training_id = response.json()["id"]
            self.report["training_optimization_id"] = training_id
            while True:
                self.assertIsNone(process.returncode, "Launcher exited.\n" + "".join(logs)[-6000:])
                async with sessions() as db:
                    seed_optimization = await db.get(Optimization, training_id)
                    self.assertNotIn(seed_optimization.state, {"paused", "pausing"}, f"{seed_optimization.pause_reason}\n{''.join(logs)[-6000:]}")
                    if seed_optimization.state == "completed":
                        launcher = await db.scalar(select(Launcher).where(Launcher.user_id == owner))
                        launcher_ids.add(launcher.id)
                        break
                await asyncio.sleep(0.1)
            self.report["phase_seconds"]["training_solver"] = time.monotonic() - training_started
            self.report["phase"] = "model_training"
            model_started = time.monotonic()
            phase_started = model_started
            from hybrid_model_fixture import prepare_hybrid_model
            hybrid = await prepare_hybrid_model(sessions, owner=owner, experiment_id=experiment_id,
                vars_schema=built["varsSchema"], launcher_id=launcher.id,
                storage_root=temporary / "predictor-storage", report=self.report,
                rules=[{"label": name, "target": [], "methodId": "prediction", "parameters": {}, "result": schema}
                       for name, schema in program["recordedData"].items()])
            self.report["phase_seconds"]["model_training"] = time.monotonic() - model_started
            training_seconds = time.monotonic() - training_started
            started = asyncio.get_running_loop().time()
            self.report["phase"] = "hybrid"
            phase_started = time.monotonic()
            async with httpx.AsyncClient(base_url=base_url, timeout=30) as browser:
                response = await browser.post("/cae/optimizations", json={"request_id": str(uuid.uuid4()),
                    "experiment_id": experiment_id, "source_hash": example["bundleHash"], "vars_schema": built["varsSchema"],
                    "initial_vars": initial_vars, "axes": axes, "objective": {"calculation_id": calculation_id, "direction": "minimize"},
                    "max_trials": 5, "max_parallel": 2, "name": "Small Box kNN Hybrid acceptance", "hybrid": {**hybrid, "max_solver_runs": 3}})
                self.assertEqual(response.status_code, 200, response.text)
                optimization_id = response.json()["id"]
            # No browser connection is retained while the controller predicts,
            # selects candidates and schedules actual Solver verification.
            while True:
                async with sessions() as db:
                    optimization = await db.get(Optimization, optimization_id)
                    self.assertNotIn(optimization.state, {"paused", "pausing"}, f"{optimization.pause_reason}\n{''.join(logs)[-6000:]}")
                    if optimization.state == "completed":
                        trials = list((await db.scalars(select(Trial).where(Trial.optimization_id == optimization_id).order_by(Trial.ordinal))).all())
                        jobs = list((await db.scalars(select(Job).join(StageSubmission, StageSubmission.job_id == Job.id)
                                                     .join(Trial, Trial.id == StageSubmission.trial_id).where(Trial.optimization_id == optimization_id))).all())
                        launcher_ids.update(job.launcher_id for job in jobs if job.launcher_id)
                        break
                self.assertIsNone(process.returncode, "Launcher exited.\n" + "".join(logs)[-6000:])
                await asyncio.sleep(0.1)
            elapsed = asyncio.get_running_loop().time() - started
            self.report["phase_seconds"]["hybrid"] = elapsed
            self.report["phase"] = "job_cleanup"
            cleanup_started = time.monotonic()
            phase_started = cleanup_started
            while True:
                async with sessions() as db:
                    all_jobs = list((await db.scalars(select(Job).where(Job.user_id == owner))).all())
                    await training.reconcile(db)
                    leases = await db.scalar(select(func.count()).select_from(ModelLease))
                    grants = await db.scalar(select(func.count()).select_from(DatasetGrant))
                active_launcher = await runtime.get_launcher(launcher.id)
                remaining_processes = {(child.pid, child.create_time())
                    for child in psutil.Process(process.pid).children(recursive=True)} - launcher_processes
                if (all(job.state == "succeeded" and job.cleaned_at is not None for job in all_jobs)
                        and not leases and not grants and active_launcher is not None
                        and not active_launcher.instances and active_launcher.resources.get("cpu_reserved") == 0
                        and not remaining_processes):
                    break
                await asyncio.sleep(0.1)
            self.report["phase_seconds"]["job_cleanup"] = time.monotonic() - cleanup_started
            self.report["flow_seconds"] = time.monotonic() - flow_started
            self.report["cleanup_verified"] = True
            self.report["cleanup"] = {"model_leases": leases, "dataset_grants": grants,
                "launcher_instances": 0, "cpu_reserved": 0, "worker_processes": 0}
            await flow_timeout.__aexit__(None, None, None)
            flow_timeout = None
            self.report["phase"] = "result_assertions"
            phase_started = time.monotonic()
            async with sessions() as db:
                evaluations = list((await db.scalars(select(Evaluation).where(Evaluation.optimization_id == optimization_id))).all())
                child_jobs = list((await db.scalars(select(Job).where(Job.artifact_metadata["optimization_id"].astext == optimization_id,
                    Job.artifact_metadata.has_key("optimization_parent")))).all())
                self.assertEqual(await db.scalar(select(func.count()).select_from(ModelLease)), 0)
                calculations = (await db.execute(select(Evaluation, StageSubmission, Job)
                    .join(EvaluationSubmission, EvaluationSubmission.evaluation_id == Evaluation.id)
                    .join(StageSubmission, StageSubmission.id == EvaluationSubmission.submission_id)
                    .join(Job, Job.id == StageSubmission.job_id)
                    .where(Evaluation.optimization_id == optimization_id, StageSubmission.stage == "calculate"))).all()
                recorded = (await db.execute(select(Measurement, RecordedData)
                    .join(RecordedData, RecordedData.measurement_id == Measurement.id)
                    .join(ExperimentRecord, ExperimentRecord.id == RecordedData.experiment_record_id)
                    .where(Measurement.experiment_id == experiment_id, ExperimentRecord.name == "totalCurrent"))).all()
            predicted = [item for item in evaluations if item.kind == "prediction"]
            verified = [item for item in evaluations if item.kind == "solver"]
            self.assertEqual(len(trials), 5)
            self.assertEqual(len(predicted), 5)
            self.assertEqual(len(verified), 3)
            self.assertTrue(all(item.state == "succeeded" for item in evaluations))
            self.assertTrue(all(item.measurement_id is None for item in predicted))
            self.assertTrue(all(item.measurement_id is not None for item in verified))
            self.assertTrue(child_jobs)
            self.assertTrue(all(job.state == "succeeded" and job.cleaned_at is not None for job in jobs))
            self.assertTrue(all(job.cleaned_at is not None for job in child_jobs))
            solver_jobs = [job for job in jobs if job.slave_app_id == "cae"]
            self.assertEqual(len(solver_jobs), 3)
            self.assertTrue(all(job.started_at for job in solver_jobs))
            training_solver_jobs = [job for job in all_jobs if job.slave_app_id == "cae"
                and (job.artifact_metadata or {}).get("optimization_id") == training_id]
            self.assertEqual(len(training_solver_jobs), 3)
            self.assertTrue(all(job.started_at for job in training_solver_jobs))
            self.assertEqual(len(calculations), len(evaluations))
            source_hash = hashlib.sha256(source.encode()).hexdigest()
            self.assertEqual(optimization.definition["calculations"][0]["source_hash"], source_hash)
            self.assertEqual(optimization.settings["objective"], {"direction": "minimize"})
            for item, submission, job in calculations:
                self.assertEqual(job.input["calculations"], optimization.definition["calculations"])
                self.assertEqual(item.definition_hash, optimization.definition["hash"])
                self.assertEqual(submission.result["calculations"][0]["source_hash"], source_hash)
                if item.kind == "prediction":
                    self.assertEqual(job.input["evaluation_id"], item.id)
                    self.assertEqual(job.input["candidate_id"], item.trial_id)
                    self.assertEqual(job.input["prediction"], item.artifact)
                else:
                    self.assertEqual(job.input["measurement_id"], item.measurement_id)
            self.assertEqual(len(recorded), 6)
            currents, tensors = {}, {}
            self.report["measurements"] = []
            for measurement, row in recorded:
                actual = recorded_current(row.data)
                expected = 0.5 * measurement.vars["width"] / measurement.vars["length"]
                self.assertTrue(math.isclose(actual, expected, rel_tol=1e-6, abs_tol=1e-9), (measurement.vars, actual, expected))
                currents[measurement.id], tensors[measurement.id] = actual, row.data
                self.report["measurements"].append({"id": measurement.id, "vars": measurement.vars,
                    "current": actual, "analytic_current": expected, "current_error": actual - expected})
            predicted_by_trial = {item.trial_id: item for item in predicted}
            verified_by_trial = {item.trial_id: item for item in verified}
            self.report["candidates"] = []
            for trial in trials:
                prediction = predicted_by_trial[trial.id]
                solver = verified_by_trial.get(trial.id)
                saved = prediction_artifact(prediction.artifact, objects)
                output = next(item for item in saved["output"] if item["layout"]["key"] == "totalCurrent")
                self.assertEqual(output["layout"]["shape"], [1] * 7)
                self.assertEqual(len(output["values"]), 1)
                predicted_current = output["values"][0]
                predicted_objective = prediction.result["objective"]
                self.assertEqual(saved["provenance"]["modelId"], hybrid["model_id"])
                self.assertEqual(saved["provenance"]["modelRevision"], hybrid["model_revision"])
                self.assertEqual(saved["provenance"]["manifestChecksum"], self.report["model_training"]["checksum"])
                self.assertEqual(prediction.source, optimization.definition["hybrid"])
                self.assertAlmostEqual(predicted_objective, abs(predicted_current - 0.11), delta=1e-12)
                verified_current = verified_objective = None
                if solver is not None:
                    self.assertNotEqual(prediction.id, solver.id)
                    self.assertEqual(prediction.fingerprint, solver.fingerprint)
                    self.assertEqual(prediction.definition_hash, solver.definition_hash)
                    self.assertIsNone(solver.artifact)
                    self.assertEqual(trial.measurement_id, solver.measurement_id)
                    self.assertEqual(trial.result, solver.result)
                    verified_current = currents[solver.measurement_id]
                    verified_objective = solver.result["objective"]
                    self.assertAlmostEqual(verified_objective, abs(verified_current - 0.11), delta=1e-12)
                    self.assertEqual(saved["candidate_box_grids"]["totalCurrent"], tensors[solver.measurement_id]["boxGrid"])
                self.report["candidates"].append({"trial_id": trial.id, "ordinal": trial.ordinal, "vars": trial.variables,
                    "prediction_evaluation_id": prediction.id, "solver_evaluation_id": solver.id if solver else None,
                    "measurement_id": solver.measurement_id if solver else None,
                    "definition_hash": prediction.definition_hash, "calculation_source_hash": source_hash,
                    "predicted_current": predicted_current, "verified_current": verified_current,
                    "analytic_current": 0.5 * trial.variables["width"] / trial.variables["length"],
                    "predicted_objective": predicted_objective, "verified_objective": verified_objective,
                    "current_delta": predicted_current - verified_current if solver else None,
                    "objective_delta": predicted_objective - verified_objective if solver else None,
                    "current_absolute_error": abs(predicted_current - verified_current) if solver else None,
                    "objective_absolute_error": abs(predicted_objective - verified_objective) if solver else None})
            self.assertEqual(trials[0].variables, initial_vars)
            initial_result = self.report["candidates"][0]
            self.assertAlmostEqual(initial_result["predicted_current"], initial_result["verified_current"], delta=1e-12)
            self.assertTrue(math.isclose(initial_result["predicted_objective"], initial_result["verified_objective"],
                rel_tol=1e-6, abs_tol=1e-12), initial_result)
            self.assertAlmostEqual(initial_result["predicted_current"], 0.1, delta=1e-7)
            best = next(trial for trial in trials if trial.id == optimization.best_trial_id)
            self.assertLess(self.report["flow_seconds"], 180)
            async with httpx.AsyncClient(base_url=base_url) as browser:
                restored = (await browser.get(f"/cae/optimizations/{optimization_id}")).json()
                history = (await browser.get(f"/cae/optimizations/{optimization_id}/trials")).json()
                self.assertEqual(restored["best_trial"]["id"], best.id)
                self.assertEqual(restored["best_trial"], restored["best_verified_trial"])
                self.assertIsNotNone(restored["best_predicted_trial"])
                self.assertIsNone(restored["best_predicted_trial"]["measurement_id"])
                self.assertEqual(restored["definition"]["hybrid"]["model_revision"], hybrid["model_revision"])
                self.assertEqual(restored["definition"]["hybrid"]["checksum"], self.report["model_training"]["checksum"])
                self.assertEqual(restored["solver_budget"], {"limit": 3, "used": 3, "reserved": 0, "remaining": 0})
                self.assertEqual(history["total"], 5)
                self.assertEqual(sum(len(item["evaluations"]) for item in history["items"]), 8)
            report = {**self.report, "example": example["coordinate"], "source_hash": example["bundleHash"],
                "catalog_revision": manifest["catalog_revision"], "optimization_id": optimization_id, "trials": len(trials),
                "training_seconds": training_seconds, "training_solver_runs": len(training_solver_jobs), "solver_runs": len(solver_jobs),
                "total_solver_runs": len(training_solver_jobs) + len(solver_jobs),
                "prediction_evaluations": len(predicted), "verified_evaluations": len(verified), "child_jobs": len(child_jobs),
                "elapsed_seconds": elapsed, "best_objective": best.result["objective"], "best_vars": best.variables,
                "model": hybrid, "browser_disconnected_during_execution": True, "reconnected_history_verified": True,
                "model_checksum": restored["definition"]["hybrid"]["checksum"],
                "solver_budget": restored["solver_budget"], "termination_reason": restored["termination_reason"],
                "predictor_cleanup": [{"job_id": job.id, "state": job.state,
                    "cleaned_at": job.cleaned_at.isoformat() if job.cleaned_at else None} for job in child_jobs],
                "cleanup_verified": True, "object_storage": "local HTTP bucket with real hash/size validation"}
            report.update(await execution_report("passed"))
            self.report.update(report)
            self.report["phase_seconds"]["result_assertions"] = time.monotonic() - phase_started
        except BaseException as error:
            timeout_error = None
            if flow_timeout is not None:
                try:
                    await flow_timeout.__aexit__(type(error), error, error.__traceback__)
                except TimeoutError as converted:
                    self.report["deadline_exceeded"] = True
                    timeout_error = converted
                flow_timeout = None
            self.report["phase_seconds"].setdefault(self.report["phase"], time.monotonic() - phase_started)
            if flow_started is not None:
                self.report.setdefault("flow_seconds", time.monotonic() - flow_started)
            try:
                async with asyncio.timeout(10):
                    self.report.update(await execution_report("failed"))
            except Exception as snapshot_error:
                self.report["snapshot_error"] = type(snapshot_error).__name__
            if timeout_error is not None:
                raise timeout_error from error
            raise
        finally:
            # Cleanup remains mandatory after the flow deadline and is measured
            # separately. A cleanup failure must never leave a passing report.
            teardown_started = time.monotonic()
            cleanup_errors = []
            for label, operation in (("controller", controller.stop_controller), ("dispatcher", orchestrator.stop_dispatcher)):
                try:
                    await asyncio.wait_for(operation(), 10)
                except Exception as cleanup_error:
                    cleanup_errors.append(f"{label}: {cleanup_error}")
            for owned_process in (build, process):
                try:
                    await stop_process_tree(owned_process)
                except Exception as cleanup_error:
                    cleanup_errors.append(f"process: {cleanup_error}")
            if log_task is not None:
                try:
                    await asyncio.wait_for(log_task, 10)
                except Exception as cleanup_error:
                    cleanup_errors.append(f"log: {cleanup_error}")
            log_file.close()
            server.should_exit = True
            if server_task is not None:
                try:
                    await asyncio.wait_for(server_task, 15)
                except Exception as cleanup_error:
                    cleanup_errors.append(f"server: {cleanup_error}")
            listener.close()
            # A setup failure may occur before the first Job records its launcher.
            launcher_ids.update(identity for identity, value in runtime.launchers.items()
                if value.websocket.scope.get("app") is app)
            for launcher_id in launcher_ids:
                await runtime.remove_launcher(launcher_id)
            try:
                await engine.dispose()
            except Exception as cleanup_error:
                cleanup_errors.append(f"engine: {cleanup_error}")
            patches.close()
            catalog.close()
            try:
                temporary_directory.cleanup()
            except Exception as cleanup_error:
                cleanup_errors.append(f"temporary files: {cleanup_error}")
            self.report["phase_seconds"]["environment_teardown"] = time.monotonic() - teardown_started
            self.report["environment_cleanup_verified"] = not cleanup_errors
            if cleanup_errors:
                self.report["cleanup_errors"] = cleanup_errors
                if sys.exc_info()[0] is None:
                    self.fail("; ".join(cleanup_errors))
