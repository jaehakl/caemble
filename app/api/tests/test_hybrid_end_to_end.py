"""Opt-in fixed and automatically rebuilt Hybrid flows with real local workers."""
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
import platform
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
from prediction.db import DatasetGrant, DatasetRevision, ModelLease, ModelRevision
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
from hybrid_metrics_fixture import hybrid_jobs_cleaned, recorded_solver_invocations, recorded_values


THERMAL_POINTS = ((100, 12), (90, 11), (90, 13), (110, 11), (110, 13))
THERMAL_BOUNDS = {"conductorLength": (90, 110), "conductorWidth": (11, 13)}
THERMAL_TARGET_K = 293.168
THERMAL_RMSE_K = 0.001
THERMAL_CALCULATION = """import { abs, max } from 'mathjs'

/** @param {CalculationInput} record */
export default function calculate(record) {
  const temperature = record['temperature']
  return { dtype: 'float64', data: Number(abs(Number(max(temperature.data)) - 293.168)) }
}
"""


def prediction_artifact(reference, objects):
    prefix = f"caemble/objects/{reference['id']}/"
    raw = b"".join(objects[key] for key in sorted(objects) if key.startswith(prefix))
    assert len(raw) == reference["byteLength"]
    assert hashlib.sha256(raw).hexdigest() == reference["sha256"]
    assert reference["encoding"] == "json"
    return json.loads(raw)


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


class HybridEndToEndTests(unittest.TestCase):
    @unittest.skipUnless(os.getenv("RUN_HYBRID_E2E") == "1", "Set RUN_HYBRID_E2E=1 for the real kNN Hybrid demo.")
    def test_fixed_knn_revision_selects_real_verified_candidates_without_browser(self):
        self.run_case(thermal=False)

    @unittest.skipUnless(os.getenv("RUN_AUTOMATIC_HYBRID_E2E") == "1", "Set RUN_AUTOMATIC_HYBRID_E2E=1 for automatic rebuilding.")
    def test_automatic_knn_rebuild_uses_new_solver_data_in_the_next_round(self):
        self.run_case(thermal=False, automatic=True)

    @unittest.skipUnless(os.getenv("RUN_SEARCH_STRATEGY_E2E") == "1", "Set RUN_SEARCH_STRATEGY_E2E=1 for random Hybrid search.")
    def test_random_knn_revision_selects_real_verified_candidates_without_browser(self):
        self.run_case(thermal=False, algorithm={"id": "random", "version": 1,
            "config": {"seed": 42, "candidates_per_round": 4}})

    @unittest.skipUnless(os.getenv("RUN_MLP_HYBRID_E2E") == "1", "Set RUN_MLP_HYBRID_E2E=1 for the real thermal MLP Hybrid demo.")
    def test_fixed_mlp_revision_uses_heldout_temperature_and_real_verification(self):
        self.run_case(thermal=True)

    def run_case(self, *, thermal, algorithm=None, automatic=False):
        self.thermal = thermal
        self.algorithm = algorithm
        self.automatic = automatic
        self.report_prefix = "mlp-hybrid-demo" if thermal else "hybrid-demo"
        if algorithm is not None:
            self.report_prefix = "random-hybrid-demo"
        if automatic:
            self.report_prefix = "automatic-hybrid-demo"
        self.test_started = time.monotonic()
        report_dir = Path(__file__).resolve().parents[3] / ".work"
        report_dir.mkdir(exist_ok=True)
        self.report = {"status": "running", "phase": "database_setup", "budget_seconds": 180,
            "phase_seconds": {}, "cleanup_verified": False, "environment_cleanup_verified": False,
            "run_id": str(uuid.uuid4()), "started_at": datetime.now(timezone.utc).isoformat(),
            "environment": {"platform": platform.platform(), "processor": platform.processor(),
                "logical_cpu_count": os.cpu_count(), "physical_memory_bytes": psutil.virtual_memory().total,
                "python": platform.python_version(), "launcher_cpu_cores": 4, "worker_cpu_cores": 1, "gpu_count": 0}}
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
            name = f"{self.report_prefix}-{'acceptance' if self.report['status'] == 'passed' else 'last-failure'}.json"
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
        log_file = (report_dir / f"{self.report_prefix}-launcher.log").open("w", encoding="utf-8")

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
                        "created_at": job.created_at.isoformat(),
                        "queue_seconds": (job.started_at - job.created_at).total_seconds() if job.started_at else None,
                        "started_at": job.started_at.isoformat() if job.started_at else None,
                        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
                        "duration_seconds": (job.finished_at - job.started_at).total_seconds()
                            if job.finished_at and job.started_at else None,
                        "cleaned": job.cleaned_at is not None, "allocation": job.allocation,
                        "error": job.last_error} for job in all_jobs],
                    "training_solver_runs": sum(job.slave_app_id == "cae" and job.started_at is not None
                        and (job.artifact_metadata or {}).get("optimization_id") in self.report.get("training_optimization_ids", []) for job in all_jobs),
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
            example = catalog.experiment("caemble:experiment/caemble/verified/electro-thermal-notched-bar@6.0.2" if self.thermal
                else "caemble:experiment/caemble/verified/hybrid-box-conductor@1.0.0")
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
            source = THERMAL_CALCULATION if self.thermal else example["calculations"][0]["source_code"]
            record_name = "temperature" if self.thermal else "totalCurrent"
            target = THERMAL_TARGET_K if self.thermal else 0.11
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
                                                       name="Temperature target error" if self.thermal else "Current target error", owner_id=owner, revision=1)
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
            if self.thermal:
                axes = [{"name": name, "indices": [], "min": THERMAL_BOUNDS[name][0], "max": THERMAL_BOUNDS[name][1]}
                    if name in THERMAL_BOUNDS else {"name": name, "indices": [], "fixed": True}
                    for name in sorted(built["varsSchema"])]
            training_points = [{**initial_vars, "conductorLength": length, "conductorWidth": width}
                for length, width in THERMAL_POINTS] if self.thermal else [initial_vars]
            training_count = len(THERMAL_POINTS) if self.thermal else 3
            training_started = time.monotonic()
            self.report["phase_seconds"]["fixture_setup"] = training_started - setup_started
            flow_started = training_started
            phase_started = training_started
            self.report["phase"] = "training_solver"
            flow_timeout = asyncio.timeout_at(asyncio.get_running_loop().time() + 180)
            await flow_timeout.__aenter__()
            training_ids = []
            async with httpx.AsyncClient(base_url=base_url, timeout=30) as browser:
                for variables in training_points:
                    response = await browser.post("/cae/optimizations", json={"request_id": str(uuid.uuid4()),
                        "experiment_id": experiment_id, "source_hash": example["bundleHash"], "vars_schema": built["varsSchema"],
                        "initial_vars": variables, "axes": axes, "objective": {"calculation_id": calculation_id, "direction": "minimize"},
                        "max_trials": 1 if self.thermal else 3, "max_parallel": 2, "name": "Hybrid training data"})
                    self.assertEqual(response.status_code, 200, response.text)
                    training_ids.append(response.json()["id"])
                    self.report["training_optimization_ids"] = list(training_ids)
            self.report["training_optimization_id"] = training_ids[0]
            while True:
                self.assertIsNone(process.returncode, "Launcher exited.\n" + "".join(logs)[-6000:])
                async with sessions() as db:
                    seed_optimizations = list((await db.scalars(select(Optimization).where(Optimization.id.in_(training_ids)))).all())
                    for seed_optimization in seed_optimizations:
                        self.assertNotIn(seed_optimization.state, {"paused", "pausing"}, f"{seed_optimization.pause_reason}\n{''.join(logs)[-6000:]}")
                    if all(item.state == "completed" for item in seed_optimizations):
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
                algorithm="mlp" if self.thermal else "knn", measurement_count=training_count,
                rules=[{"label": name, "target": [], "methodId": "prediction", "parameters": {}, "result": schema}
                       for name, schema in program["recordedData"].items() if not self.thermal or name == record_name])
            if self.thermal:
                trained = self.report["model_training"]
                quality = trained["quality_report"]
                self.assertEqual(quality["status"], "complete")
                self.assertEqual(quality["split"]["trainingGroupCount"], 4)
                self.assertEqual(quality["split"]["validationGroupCount"], 1)
                self.assertTrue(set(quality["split"]["trainingMeasurementIds"]).isdisjoint(quality["split"]["validationMeasurementIds"]))
                heldout = next(point for point in trained["design_points"]
                    if point["id"] in quality["split"]["validationMeasurementIds"])
                self.assertEqual((heldout["vars"]["conductorLength"], heldout["vars"]["conductorWidth"]), (110, 13))
                self.assertEqual(len(quality["records"]), 1)
                output_quality = quality["records"][0]
                self.assertEqual((output_quality["key"], output_quality["unit"]), ("temperature", "K"))
                self.assertEqual(output_quality["components"][0]["component"], "value")
                self.assertLessEqual(output_quality["components"][0]["rmse"], THERMAL_RMSE_K)
                hybrid["quality_requirements"] = [{"recordId": output_quality["recordId"],
                    "component": "value", "rmseMaximum": THERMAL_RMSE_K}]
            self.report["phase_seconds"]["model_training"] = time.monotonic() - model_started
            if self.automatic:
                hybrid["model_update_policy"] = {"id": "new_solver_results", "version": 1, "config": {
                    "min_new_measurements": 1, "max_updates": 1,
                    "update_timeout_seconds": 180, "total_timeout_seconds": 180}}
            training_seconds = time.monotonic() - training_started
            started = asyncio.get_running_loop().time()
            self.report["phase"] = "hybrid"
            phase_started = time.monotonic()
            async with httpx.AsyncClient(base_url=base_url, timeout=30) as browser:
                response = await browser.post("/cae/optimizations", json={"request_id": str(uuid.uuid4()),
                    "experiment_id": experiment_id, "source_hash": example["bundleHash"], "vars_schema": built["varsSchema"],
                    "initial_vars": initial_vars, "axes": axes, "objective": {"calculation_id": calculation_id, "direction": "minimize"},
                    "max_trials": 5, "max_parallel": 2, "name": "Temperature MLP Hybrid acceptance" if self.thermal else "Small Box kNN Hybrid acceptance",
                    "hybrid": {**hybrid, "max_solver_runs": 3},
                    **({"algorithm": self.algorithm} if self.algorithm else {})})
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
                if (hybrid_jobs_cleaned(all_jobs)
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
                prediction_submissions = list((await db.scalars(select(StageSubmission)
                    .join(Trial, Trial.id == StageSubmission.trial_id)
                    .where(Trial.optimization_id == optimization_id, StageSubmission.stage == "predict"))).all())
                recorded = (await db.execute(select(Measurement, RecordedData)
                    .join(RecordedData, RecordedData.measurement_id == Measurement.id)
                    .join(ExperimentRecord, ExperimentRecord.id == RecordedData.experiment_record_id)
                    .where(Measurement.experiment_id == experiment_id, ExperimentRecord.name == record_name))).all()
                invocation_records = list((await db.scalars(select(RecordedData)
                    .where(RecordedData.measurement_id.in_([measurement.id for measurement, _ in recorded])))).all())
                if self.automatic:
                    updates = optimization.optimizer_state["model_update"]["updates"]
                    self.assertEqual(len(updates), 1)
                    update = updates[0]
                    self.assertEqual((update["origin"], update["state"], update["adopted_round"]), ("automatic", "adopted", 1))
                    revision = await db.get(ModelRevision, (update["model_id"], update["revision"]))
                    snapshot = await db.get(DatasetRevision, (revision.dataset_id, revision.dataset_revision))
                    first_solver = next(item for item in evaluations if item.kind == "solver" and item.trial_id == trials[0].id)
                    self.assertIn(str(first_solver.measurement_id), snapshot.summary["sample_fingerprints"])
                    self.report["automatic_training"] = {"model_revision": revision.revision,
                        "snapshot": update["target_snapshot"], "included_solver_measurement": first_solver.measurement_id,
                        "execution_metrics": revision.artifact.get("execution_metrics"), "attempt": update["automatic_attempt"]}
                baseline_trials = list((await db.scalars(select(Trial).where(Trial.optimization_id.in_(training_ids))
                    .order_by(Trial.ordinal))).all())
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
            self.assertTrue(hybrid_jobs_cleaned(all_jobs))
            solver_jobs = [job for job in jobs if job.slave_app_id == "cae"]
            self.assertEqual(len(solver_jobs), 3)
            self.assertTrue(all(job.started_at for job in solver_jobs))
            training_solver_jobs = [job for job in all_jobs if job.slave_app_id == "cae"
                and (job.artifact_metadata or {}).get("optimization_id") in training_ids]
            self.assertEqual(len(training_solver_jobs), training_count)
            self.assertTrue(all(job.started_at for job in training_solver_jobs))
            if self.thermal:
                self.assertCountEqual([point["vars"] for point in self.report["model_training"]["design_points"]], training_points)
                self.assertTrue(all(not job.allocation.get("gpu_devices") for job in all_jobs if job.allocation))
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
            self.assertEqual(len(recorded), training_count + 3)
            record_maxima, tensors = {}, {}
            self.report["measurements"] = []
            for measurement, row in recorded:
                values = recorded_values(row.data)
                actual = max(values)
                if self.thermal:
                    self.assertEqual(row.data["shape"], [12, 6, 6, 1, 1, 1, 1])
                    self.assertEqual(sum(value == 0 for value in values), 24)
                    self.assertGreater(actual, 293.15)
                    self.assertLess(actual, 293.18)
                else:
                    expected = 0.5 * measurement.vars["width"] / measurement.vars["length"]
                    self.assertTrue(math.isclose(actual, expected, rel_tol=1e-6, abs_tol=1e-9), (measurement.vars, actual, expected))
                record_maxima[measurement.id], tensors[measurement.id] = actual, row.data
                self.report["measurements"].append({"id": measurement.id, "vars": measurement.vars,
                    "record": record_name, "unit": "K" if self.thermal else "A", "maximum": actual,
                    **({"current": actual, "analytic_current": expected, "current_error": actual - expected} if not self.thermal else {})})
            predicted_by_trial = {item.trial_id: item for item in predicted}
            verified_by_trial = {item.trial_id: item for item in verified}
            self.report["candidates"] = []
            for trial in trials:
                prediction = predicted_by_trial[trial.id]
                solver = verified_by_trial.get(trial.id)
                saved = prediction_artifact(prediction.artifact, objects)
                output = next(item for item in saved["output"] if item["layout"]["key"] == record_name)
                self.assertEqual(output["layout"]["shape"], [12, 6, 6, 1, 1, 1, 1] if self.thermal else [1] * 7)
                self.assertEqual(len(output["values"]), 432 if self.thermal else 1)
                self.assertTrue(all(math.isfinite(value) for value in output["values"]))
                predicted_value = max(output["values"])
                predicted_objective = prediction.result["objective"]
                self.assertEqual(saved["provenance"]["modelId"], hybrid["model_id"])
                expected_source = optimization.optimizer_state["round_sources"][str(trial.round_index)]
                self.assertEqual(saved["provenance"]["modelRevision"], expected_source["model_revision"])
                self.assertEqual(saved["provenance"]["manifestChecksum"], expected_source["checksum"])
                self.assertEqual(prediction.source, expected_source)
                if not self.automatic:
                    self.assertEqual(prediction.source, optimization.definition["hybrid"])
                else:
                    self.assertEqual(expected_source["model_revision"], 1 if trial.round_index == 0 else 2)
                self.assertAlmostEqual(predicted_objective, abs(predicted_value - target), delta=1e-12)
                verified_value = verified_objective = None
                if solver is not None:
                    self.assertNotEqual(prediction.id, solver.id)
                    self.assertEqual(prediction.fingerprint, solver.fingerprint)
                    self.assertEqual(prediction.definition_hash, solver.definition_hash)
                    self.assertIsNone(solver.artifact)
                    self.assertEqual(trial.measurement_id, solver.measurement_id)
                    self.assertEqual(trial.result, solver.result)
                    verified_value = record_maxima[solver.measurement_id]
                    verified_objective = solver.result["objective"]
                    self.assertAlmostEqual(verified_objective, abs(verified_value - target), delta=1e-12)
                    self.assertEqual(saved["candidate_box_grids"][record_name], tensors[solver.measurement_id]["boxGrid"])
                output_label = "maximum_temperature" if self.thermal else "current"
                self.report["candidates"].append({"trial_id": trial.id, "ordinal": trial.ordinal, "vars": trial.variables,
                    "prediction_evaluation_id": prediction.id, "solver_evaluation_id": solver.id if solver else None,
                    "measurement_id": solver.measurement_id if solver else None,
                    "definition_hash": prediction.definition_hash, "calculation_source_hash": source_hash,
                    "model_revision": prediction.source["model_revision"], "model_checksum": prediction.source["checksum"],
                    f"predicted_{output_label}": predicted_value, f"verified_{output_label}": verified_value,
                    **({"analytic_current": 0.5 * trial.variables["width"] / trial.variables["length"]} if not self.thermal else {}),
                    "predicted_objective": predicted_objective, "verified_objective": verified_objective,
                    f"{output_label}_delta": predicted_value - verified_value if solver else None,
                    "objective_delta": predicted_objective - verified_objective if solver else None,
                    f"{output_label}_absolute_error": abs(predicted_value - verified_value) if solver else None,
                    "objective_absolute_error": abs(predicted_objective - verified_objective) if solver else None})
            self.assertEqual(trials[0].variables, initial_vars)
            initial_result = self.report["candidates"][0]
            self.assertIsNotNone(initial_result["solver_evaluation_id"])
            if not self.thermal:
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
                if self.algorithm is not None:
                    self.assertEqual(restored["settings"]["algorithm"], self.algorithm)
                    self.assertIn("rng_state", restored["optimizer_state"]["algorithm_state"]["data"])
                self.assertEqual(restored["best_trial"], restored["best_verified_trial"])
                self.assertIsNotNone(restored["best_predicted_trial"])
                self.assertIsNone(restored["best_predicted_trial"]["measurement_id"])
                self.assertEqual(restored["definition"]["hybrid"]["model_revision"], hybrid["model_revision"])
                self.assertEqual(restored["definition"]["hybrid"]["checksum"], self.report["model_training"]["checksum"])
                if self.thermal:
                    self.assertEqual(restored["definition"]["hybrid"]["quality_requirements"], hybrid["quality_requirements"])
                    self.assertEqual(restored["definition"]["hybrid"]["quality_report"], self.report["model_training"]["quality_report"])
                    self.assertEqual(restored["definition"]["hybrid"]["quality_assessment"]["status"], "passed")
                self.assertEqual(restored["solver_budget"], {"limit": 3, "used": 3, "reserved": 0, "remaining": 0})
                self.assertEqual(history["total"], 5)
                self.assertEqual(sum(len(item["evaluations"]) for item in history["items"]), 8)
                if self.automatic:
                    self.assertEqual(restored["model_update"]["active_model"]["model_revision"], 2)
                    self.assertEqual(restored["model_update"]["automatic"]["attempts"], 1)
            prediction_metrics = [{"job_id": submission.job_id, **submission.result["execution_metrics"]}
                for submission in prediction_submissions if submission.result.get("execution_metrics") is not None]
            if self.thermal:
                self.assertEqual(len(prediction_metrics), len(prediction_submissions))
                self.assertEqual(sum(len(submission.result["candidates"]) for submission in prediction_submissions), 5)
                for metrics in prediction_metrics:
                    self.assertIsNotNone(metrics["load"])
                    self.assertTrue(metrics["batches"])
                    self.assertTrue(all(item is not None for item in metrics["batches"]))
                self.assertIsNotNone(self.report["model_training"]["training_metrics"])
            # A batch is counted once at its parent submission, never once per
            # candidate. Job durations include orchestration and may overlap.
            prediction_seconds = sum(metrics["elapsedSeconds"] for entry in prediction_metrics
                for metrics in entry["batches"] if metrics is not None)
            model_load_seconds = sum(entry["load"]["elapsedSeconds"] for entry in prediction_metrics if entry["load"] is not None)
            solver_job_seconds = sum((job.finished_at - job.started_at).total_seconds()
                for job in [*training_solver_jobs, *solver_jobs])
            # Invocation ordinals are local to each Task. Multiple Records from
            # the same call are evidence for one invocation, not extra calls.
            invocations = recorded_solver_invocations(
                [(row.measurement_id, row.data["provenance"]) for row in invocation_records],
                measurement_ids=set(tensors), task_names=set(program["tasks"]))
            product_solver_calls = len(invocations)
            self.assertEqual(product_solver_calls, (training_count + 3) * len(program["tasks"]))
            dataset_measurement_ids = set(self.report["model_training"]["dataset_measurement_ids"])
            verified_measurement_ids = {item.measurement_id for item in verified}
            solver_calls_by_phase = {phase: {task: sum(identity in identities and recorded_task == task
                for identity, recorded_task, _ in invocations) for task in program["tasks"]}
                for phase, identities in (("training", dataset_measurement_ids), ("hybrid", verified_measurement_ids))}
            self.assertEqual(solver_calls_by_phase["training"], {task: training_count for task in program["tasks"]})
            self.assertEqual(solver_calls_by_phase["hybrid"], {task: 3 for task in program["tasks"]})
            report = {**self.report, "example": example["coordinate"], "source_hash": example["bundleHash"],
                "catalog_revision": manifest["catalog_revision"], "optimization_id": optimization_id, "trials": len(trials),
                "training_seconds": training_seconds, "training_solver_runs": len(training_solver_jobs), "solver_runs": len(solver_jobs),
                "total_solver_runs": len(training_solver_jobs) + len(solver_jobs),
                "product_solver_calls": product_solver_calls,
                "solver_calls_by_phase": solver_calls_by_phase,
                "prediction_evaluations": len(predicted), "verified_evaluations": len(verified), "child_jobs": len(child_jobs),
                "prediction_execution_metrics": prediction_metrics, "prediction_seconds": prediction_seconds,
                "model_load_seconds": model_load_seconds, "solver_job_seconds": solver_job_seconds,
                "target": {"record": record_name, "reduction": "max", "value": target, "unit": "K" if self.thermal else "A"},
                "quality_assessment": restored["definition"]["hybrid"].get("quality_assessment"),
                "elapsed_seconds": elapsed, "best_objective": best.result["objective"], "best_vars": best.variables,
                "model": hybrid, "browser_disconnected_during_execution": True, "reconnected_history_verified": True,
                "model_checksum": restored["definition"]["hybrid"]["checksum"],
                "solver_budget": restored["solver_budget"], "termination_reason": restored["termination_reason"],
                "model_update": restored["model_update"],
                "comparison": {"solver_only": {"solver_runs": len(training_solver_jobs),
                    "best_objective": min(item.result["objective"] for item in baseline_trials),
                    "elapsed_seconds": self.report["phase_seconds"]["training_solver"]},
                    "hybrid": {"solver_runs": len(solver_jobs), "best_objective": best.result["objective"],
                        "reuse_model_seconds": elapsed, "including_initial_training_seconds": training_seconds + elapsed},
                    "separate_transfer_seconds": None},
                "predictor_cleanup": [{"job_id": job.id, "state": job.state,
                    "cleaned_at": job.cleaned_at.isoformat() if job.cleaned_at else None} for job in child_jobs],
                "cleanup_verified": True, "object_storage": "local HTTP bucket with real hash/size validation"}
            report.update(await execution_report("passed"))
            report["job_costs"] = {handler: {
                "count": sum(job.handler_type == handler for job in all_jobs),
                "execution_seconds": sum((job.finished_at - job.started_at).total_seconds()
                    for job in all_jobs if job.handler_type == handler and job.started_at and job.finished_at),
                "queue_seconds": sum((job.started_at - job.created_at).total_seconds()
                    for job in all_jobs if job.handler_type == handler and job.started_at),
            } for handler in sorted({job.handler_type for job in all_jobs})}
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
