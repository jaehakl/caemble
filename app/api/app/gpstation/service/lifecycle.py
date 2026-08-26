from contextlib import asynccontextmanager

from fastapi import FastAPI
from caemble_catalog import Catalog

from db import SessionLocal, engine
from gpstation.service.job_orchestrator import job_orchestrator
from gpstation.service.job_service import JobService
from gpstation.service.state import runtime


@asynccontextmanager
async def gpstation_lifespan(app: FastAPI):
    app.state.progress = 0
    catalog = Catalog.open_readonly()
    app.state.catalog = catalog
    try:
        async with SessionLocal() as db:
            await JobService.recover_after_server_restart(db)
        await job_orchestrator.start_dispatcher()
        print("service is started.")
        yield
    finally:
        catalog.close()
        app.state.catalog = None
        await job_orchestrator.stop_dispatcher()
        await runtime.close_all_launchers()
        await engine.dispose()
        print("service is stopped.")
