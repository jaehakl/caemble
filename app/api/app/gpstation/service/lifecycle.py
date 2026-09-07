from contextlib import asynccontextmanager

from fastapi import FastAPI
from caemble_catalog import Catalog

from db import SessionLocal, engine
from gpstation.service.job_orchestrator import job_orchestrator
from gpstation.service.job_service import JobService
from gpstation.service.state import runtime
from gpstation.service.batches import fail_server_jobs
from cae.preparation import preparation_queue
from cae import recording
from gpstation.service.server_handlers import server_handlers, cancel_preparation_handlers


@asynccontextmanager
async def gpstation_lifespan(app: FastAPI):
    app.state.progress = 0
    catalog = Catalog.open_readonly()
    app.state.catalog = catalog
    server_handlers["cae.simulation"] = recording
    cancel_preparation_handlers["cae.simulation"] = preparation_queue.cancel
    try:
        async with SessionLocal() as db:
            await JobService.recover_after_server_restart(db)
            await fail_server_jobs(db, detail="server restarted", restarting=True)
        await job_orchestrator.start_dispatcher()
        await preparation_queue.start()
        print("service is started.")
        yield
    finally:
        catalog.close()
        app.state.catalog = None
        await job_orchestrator.stop_dispatcher()
        await preparation_queue.stop()
        await runtime.close_all_launchers()
        await engine.dispose()
        print("service is stopped.")
