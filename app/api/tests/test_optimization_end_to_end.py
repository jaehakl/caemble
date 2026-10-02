"""Opt-in two-candidate Optimization through real launcher, Node and CAE children."""
from __future__ import annotations

import asyncio
import base64
from contextlib import ExitStack, suppress
import hashlib
import importlib
import json
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
from optimization import controller, evaluation, integration
from optimization.db import StageSubmission, Optimization, Trial
from optimization.router import authenticated, router
from calculation.db import Calculation, CalculationSource
from simulation.db import Experiment, ExperimentRecord, Measurement, RecordedData
from db import make_async_db_url
from gpstation.db import APIKey, Job
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


@unittest.skipUnless(os.getenv("RUN_OPTIMIZATION_E2E") == "1", "Set RUN_OPTIMIZATION_E2E=1 for the small real Solver Optimization demo.")
class OptimizationEndToEndTests(unittest.TestCase):
    def test_fiber_bundle_improves_without_browser_and_reconnects_to_saved_history(self):
        self.test_started = time.monotonic()
        database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        asyncio.run(_create_database(database))
        try:
            _upgrade(database, "head")
            asyncio.run(self.verify(database))
        finally:
            asyncio.run(_drop_database(database))
            if getattr(self, "report_path", None):
                report = json.loads(self.report_path.read_text(encoding="utf-8"))
                report["total_test_seconds"] = time.monotonic() - self.test_started
                self.report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    async def verify(self, database):
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
        user = UserData(id=owner, roles=[RoleEnum.user])
        app.dependency_overrides[authenticated] = lambda: user
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
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
        catalog = Catalog.open_readonly()
        app.state.catalog = catalog
        temporary_directory = tempfile.TemporaryDirectory(prefix="caemble-optimization-")
        patches = ExitStack()
        process = log_task = server_task = None
        optimization_id = None
        started = None
        launcher_ids = set()
        logs = []
        report_dir = repo / ".work"
        report_dir.mkdir(exist_ok=True)
        log_file = (report_dir / "optimization-demo-launcher.log").open("w", encoding="utf-8")

        async def execution_report(status):
            async with sessions() as db:
                optimization = await db.get(Optimization, optimization_id)
                rows = (await db.execute(select(Trial, StageSubmission, Job)
                    .outerjoin(StageSubmission, StageSubmission.trial_id == Trial.id)
                    .outerjoin(Job, Job.id == StageSubmission.job_id).where(Trial.optimization_id == optimization_id)
                    .order_by(Trial.ordinal, StageSubmission.created_at))).all()
                return {"status": status, "optimization_id": optimization_id, "state": optimization.state,
                    "pause_reason": optimization.pause_reason, "settings": optimization.settings,
                    "runtime_id": optimization.optimizer_state.get("runtime_id"),
                    "elapsed_seconds": asyncio.get_running_loop().time() - started,
                    "budget_seconds": 180, "launcher_cpu_cores": 4, "cae_cpu_cores": 4,
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
            example = catalog.experiment("caemble:experiment/caemble/advanced-shapes/fiber-bundle@7.0.0")
            artifact_path = temporary / "artifact"
            build = await asyncio.create_subprocess_exec(
                "node", str(repo / "app/ui/dist-cli/caemble.cjs"), "--repo", str(repo), "--python", str(cae_python),
                "experiment", "build", "--example", example["coordinate"], "--vars-mode", "nominal", "--out", str(artifact_path),
                cwd=repo, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            _, error = await asyncio.wait_for(build.communicate(), 120)
            self.assertEqual(build.returncode, 0, error.decode("utf-8", errors="replace"))
            manifest = json.loads((artifact_path / "manifest.json").read_text(encoding="utf-8"))
            artifact = json.loads((artifact_path / manifest["items"][0]["file"]).read_text(encoding="utf-8"))
            built = artifact["measurement"]["experiment"]
            program = built["simulationProgram"]
            source = "export default function calculate(input) { return { dtype: 'float64', data: input.totalCurrent.data[0] }; }"
            token = f"optimization-demo-{uuid.uuid4().hex}"
            async with sessions() as db:
                role = await db.scalar(select(Role).where(Role.name == "user"))
                db.add(UserRole(user_id=owner, role_id=role.id))
                experiment = await db.get(Experiment, experiment_id)
                experiment.source_bundle, experiment.source_hash = example["sourceBundle"], example["bundleHash"]
                experiment.result_contracts = program["resultContracts"]
                for name, schema in program["recordedData"].items():
                    db.add(ExperimentRecord(experiment_id=experiment_id, name=name, dtype=schema["dtype"],
                        tensor_order=schema.get("tensorOrder", 0), quantity_kind=schema.get("quantityKind"),
                        data_schema=schema, contract_hash=f"optimization-demo-{name}"))
                calculation_source = CalculationSource(source_code=source, source_hash=hashlib.sha256(source.encode()).hexdigest(),
                                                       name="Total current", owner_id=owner, revision=1)
                db.add(calculation_source)
                await db.flush()
                calculation = Calculation(experiment_id=experiment_id, source_id=calculation_source.id, contract_status="needs_preflight")
                db.add(calculation)
                db.add(APIKey(user_id=owner, name="optimization-demo", key_prefix=uuid.uuid4().hex, key_hash=hash_token(token), scopes=["launcher"]))
                await db.commit()
                calculation_id = calculation.id
            for module in (launcher_connection, worker_connection, orchestrator_module, controller):
                patches.enter_context(patch.object(module, "SessionLocal", sessions))
            for module in (launcher_connection, orchestrator_module, controller):
                patches.enter_context(patch.object(module, "job_orchestrator", orchestrator))
            patches.enter_context(patch.object(settings, "public_api_base_url", base_url))
            patches.enter_context(patch("storage.service.bucket_client", return_value=bucket))
            patches.enter_context(patch.dict(server_handlers, clear=True))
            for name, implementation in (("cae.simulation", recording), ("cae.evaluation.build", evaluation), ("cae.evaluation.calculate", evaluation)):
                register_server_handler(name, implementation, event_context=integration.event_context, on_finished=integration.on_finished)
            server_task = asyncio.create_task(server.serve(sockets=[listener]))
            while not server.started:
                await asyncio.sleep(0.01)
            await orchestrator.start_dispatcher()
            await controller.start_controller(catalog)
            resources = temporary / "resources.toml"
            resources.write_text('cpu_cores = 4\n[defaults.cae]\ncpu_cores = 4\ngpu_count = 0\n[defaults.evaluation]\ncpu_cores = 1\ngpu_count = 0\n', encoding="utf-8")
            environment = {**os.environ, "CAEMBLE_API_URL": base_url, "CAEMBLE_ACCESS_TOKEN": token,
                "CAEMBLE_LAUNCHER_NAME": "optimization-acceptance", "CAEMBLE_RESOURCES_FILE": str(resources),
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
            initial_vars = {**built["variables"], "fiberRadius": 1.2, "taper": 0.4, "bendAngle": 0.1, "bundleRadius": 3.5}
            axes = [{"name": name, "indices": [], "fixed": name != "fiberRadius"} for name in built["varsSchema"]]
            started = asyncio.get_running_loop().time()
            async with httpx.AsyncClient(base_url=base_url, timeout=30) as browser:
                response = await browser.post("/cae/optimizations", json={"request_id": str(uuid.uuid4()),
                    "experiment_id": experiment_id, "source_hash": example["bundleHash"], "vars_schema": built["varsSchema"],
                    "initial_vars": initial_vars, "axes": axes, "objective": {"calculation_id": calculation_id, "direction": "maximize"},
                    "max_trials": 2, "max_parallel": 2, "name": "Fiber radius optimization acceptance"})
                self.assertEqual(response.status_code, 200, response.text)
                optimization_id = response.json()["id"]
            # No observer or client connection is retained while the server selects
            # candidates and schedules all three real execution stages.
            async with asyncio.timeout(180 - (asyncio.get_running_loop().time() - started)):
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
            self.assertEqual(len(trials), 2)
            self.assertTrue(all(trial.state == "succeeded" for trial in trials))
            self.assertEqual(len(jobs), 6)
            self.assertTrue(all(job.state == "succeeded" and job.cleaned_at is not None for job in jobs))
            self.assertEqual(len({job.attempt_id for job in jobs}), 6)
            baseline = trials[0].result["objective"]
            best = next(trial for trial in trials if trial.id == optimization.best_trial_id)
            self.assertGreater(best.result["objective"], baseline)
            self.assertLess(elapsed, 180)
            async with httpx.AsyncClient(base_url=base_url) as browser:
                restored = (await browser.get(f"/cae/optimizations/{optimization_id}")).json()
                history = (await browser.get(f"/cae/optimizations/{optimization_id}/trials")).json()
                self.assertEqual(restored["best_trial"]["id"], best.id)
                self.assertEqual(history["total"], 2)
                self.assertTrue(all(len(item["stages"]) == 3 for item in history["items"]))
            async with sessions() as db:
                self.assertEqual(await db.scalar(select(func.count()).select_from(Measurement)), 2)
                self.assertEqual(await db.scalar(select(func.count()).select_from(RecordedData)), 4)
            report = {"example": example["coordinate"], "optimization_id": optimization_id, "trials": len(trials), "jobs": len(jobs),
                "elapsed_seconds": elapsed, "baseline_objective": baseline, "best_objective": best.result["objective"],
                "best_vars": best.variables, "browser_disconnected_during_execution": True, "reconnected_history_verified": True,
                "cleanup_verified": True, "object_storage": "local HTTP bucket with real hash/size validation"}
            report.update(await execution_report("passed"))
            self.report_path = report_dir / "optimization-demo-acceptance.json"
            self.report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(report), flush=True)
        except BaseException as error:
            if optimization_id is not None:
                report = await execution_report(type(error).__name__)
                self.report_path = report_dir / "optimization-demo-last-failure.json"
                self.report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
                print(json.dumps(report), flush=True)
            raise
        finally:
            await controller.stop_controller()
            await orchestrator.stop_dispatcher()
            if process is not None and process.returncode is None:
                with suppress(psutil.NoSuchProcess):
                    for child in reversed(psutil.Process(process.pid).children(recursive=True)):
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
            for launcher_id in launcher_ids:
                await runtime.remove_launcher(launcher_id)
            await engine.dispose()
            patches.close()
            catalog.close()
            temporary_directory.cleanup()
