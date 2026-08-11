from contextlib import asynccontextmanager

from fastapi import FastAPI

from db import SessionLocal, engine
from gpstation.service.job_orchestrator import job_orchestrator
from gpstation.service.job_service import JobService
from gpstation.service.state import runtime
from gpstation.utils.slave_registry import initialize_slave_registry


@asynccontextmanager
async def gpstation_lifespan(app: FastAPI):
    app.state.progress = 0
    initialize_slave_registry()
    try:
        async with SessionLocal() as db:
            await JobService.recover_after_server_restart(db)
        await job_orchestrator.start_dispatcher()
        print("service is started.")
        yield
    finally:
        await job_orchestrator.stop_dispatcher()
        await runtime.close_all_launchers()
        await engine.dispose()
        print("service is stopped.")
