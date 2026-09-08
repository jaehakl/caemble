"""Public Node CLI adapters against the real API and a disposable database."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import tempfile
import unittest
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from test_calculation_database import (
    API_DIR, _create_database, _database_url, _drop_database, _ready_calculation, _seed_owners, _upgrade,
)
from db import CalculationData, Measurement, make_async_db_url
from gpstation.models import AccessKeyCreate
from gpstation.service.access_key_service import AccessKeyService
from gpstation.service.state import utcnow
from models import RoleEnum, UserData
from routers import calculation, calculation_data, measurement
from service.calculation import upsert_calculations
from user_auth.db import Role, UserRole
from user_auth.routes import get_db


@unittest.skipUnless(os.getenv("RUN_CAE_DB_TESTS") == "1", "Set RUN_CAE_DB_TESTS=1 for public CLI/API checks.")
class CalculationCliTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = f"caemble_calculation_test_{uuid.uuid4().hex}"
        asyncio.run(_create_database(cls.database))
        try:
            _upgrade(cls.database, "head")
            cls.owner, cls.other, cls.experiment, cls.other_experiment = asyncio.run(_seed_owners(cls.database))
        except BaseException:
            asyncio.run(_drop_database(cls.database))
            raise

    @classmethod
    def tearDownClass(cls):
        asyncio.run(_drop_database(cls.database))

    async def test_list_pull_run_and_paged_export_use_the_server_contract(self):
        engine = create_async_engine(make_async_db_url(_database_url(self.database)))
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        source = 'export default function calculation(input) { return { dtype: "float64", data: 4 }; }'
        async with sessions() as db:
            role = await db.scalar(select(Role.id).where(Role.name == "user"))
            db.add(UserRole(user_id=self.owner, role_id=role))
            measurements = [Measurement(user_id=self.owner, experiment_id=self.experiment,
                vars={}, material_snapshot={}, recorded_at=utcnow()) for _ in range(53)]
            foreign_measurement = Measurement(user_id=self.other, experiment_id=self.other_experiment,
                vars={}, material_snapshot={}, recorded_at=utcnow())
            db.add_all([*measurements, foreign_measurement])
            await db.commit()
            calculation_id = (await upsert_calculations(db, [_ready_calculation(
                self.experiment, "CLI constant", source, measurements[0].id,
            )], user=UserData(id=self.owner, roles=[RoleEnum.user])))[0]["id"]
            foreign_id = (await upsert_calculations(db, [_ready_calculation(
                self.other_experiment, "Private constant", source, foreign_measurement.id,
            )], user=UserData(id=self.other, roles=[RoleEnum.user])))[0]["id"]
            db.add_all([CalculationData(calculation_id=calculation_id, measurement_id=row.id,
                data={"dtype": "float64", "shape": [], "axes": [], "data": 4}) for row in measurements[:-1]])
            await db.commit()
            key = await AccessKeyService.create_user_access_key(db, self.owner,
                AccessKeyCreate(name="disposable CLI test", scopes=["caemble"]))

        app = FastAPI()
        app.include_router(calculation.router)
        app.include_router(calculation_data.router)
        app.include_router(measurement.router)
        async def database():
            async with sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        list_requests = []
        @app.middleware("http")
        async def capture_list_contract(request, call_next):
            if request.url.path in {"/calculation/list", "/calculation_data/list"}:
                list_requests.append((request.url.path, await request.json()))
            return await call_next(request)

        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
        server_task = asyncio.create_task(server.serve(sockets=[listener]))
        repo = API_DIR.parents[1]
        try:
            while not server.started:
                if server_task.done():
                    await server_task
                await asyncio.sleep(0.01)
            with tempfile.TemporaryDirectory(prefix="caemble-cli-api-") as temporary:
                directory = Path(temporary)
                env_file = directory / ".env"
                env_file.write_text("", encoding="utf-8")
                async def cli(*args, expected=0):
                    process = await asyncio.create_subprocess_exec(
                        "node", str(repo / "app/ui/dist-cli/caemble.cjs"), "--repo", str(repo),
                        "--env", str(env_file), "--json", *map(str, args),
                        cwd=directory, env={**os.environ,
                            "CAEMBLE_API_URL": f"http://127.0.0.1:{listener.getsockname()[1]}",
                            "CAEMBLE_API_TOKEN": key.secret},
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    )
                    stdout, stderr = await asyncio.wait_for(process.communicate(), 60)
                    self.assertEqual(process.returncode, expected, (stdout + stderr).decode("utf-8"))
                    return json.loads(stdout)

                rows = await cli("calculation", "list", "--experiment", self.experiment)
                self.assertEqual([row["id"] for row in rows["items"]], [calculation_id])
                await cli("calculation", "pull", calculation_id, "--out", directory / "pulled")
                self.assertEqual((directory / "pulled/calculation.js").read_text(encoding="utf-8"), source)
                metadata = json.loads((directory / "pulled/caemble.json").read_text(encoding="utf-8"))
                self.assertEqual(metadata["revision"], 1)
                await cli("calculation", "pull", foreign_id, "--out", directory / "foreign", expected=1)
                self.assertFalse((directory / "foreign").exists())
                result = await cli("calculation-data", "run", "--experiment", self.experiment,
                    "--calculation", calculation_id, "--measurement", measurements[-1].id)
                self.assertEqual(result, {"completed": 1, "total": 1})
                destination = directory / "export.json"
                exported = await cli("calculation-data", "export", "--experiment", self.experiment,
                    "--calculation", calculation_id, "--offset", 1, "--count", 51, "--out", destination)
                self.assertEqual((exported["count"], exported["total"]), (51, 53))
                data = json.loads(destination.read_text(encoding="utf-8"))
                self.assertEqual([row["measurement_id"] for row in data["items"]],
                    [row.id for row in measurements[1:52]])
                self.assertTrue(all(row["data"]["data"] == 4 for row in data["items"]))
                data_requests = [body for route, body in list_requests if route == "/calculation_data/list"]
                self.assertEqual([len(body["selected_ids"]) for body in data_requests], [50, 1])
                self.assertTrue(all(body["experiment_id"] == self.experiment for body in data_requests))
        finally:
            server.should_exit = True
            await server_task
            listener.close()
            await engine.dispose()
