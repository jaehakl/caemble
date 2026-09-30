from contextlib import asynccontextmanager

from fastapi import FastAPI
from caemble_catalog import Catalog

from db import SessionLocal, engine
from gpstation.service.job_orchestrator import job_orchestrator
from gpstation.service.job_service import JobService
from gpstation.service.state import runtime
from gpstation.service.batches import fail_server_jobs
from cae import recording
from gpstation.service.server_handlers import server_handlers
from cae.studies import evaluation
from cae.studies.controller import reconcile_once, start_controller, stop_controller


@asynccontextmanager
async def gpstation_lifespan(app: FastAPI):
    app.state.progress = 0
    catalog = Catalog.open_readonly()
    app.state.catalog = catalog
    server_handlers["cae.simulation"] = recording
    server_handlers["cae.evaluation.build"] = evaluation
    server_handlers["cae.evaluation.calculate"] = evaluation
    try:
        async with SessionLocal() as db:
            await JobService.recover_after_server_restart(db)
            await fail_server_jobs(db, detail="server restarted", restarting=True)
        await reconcile_once(catalog)
        await job_orchestrator.start_dispatcher()
        await start_controller(catalog)
        print("service is started.")
        yield
    finally:
        await stop_controller()
        await job_orchestrator.stop_dispatcher()
        await runtime.close_all_launchers()
        catalog.close()
        app.state.catalog = None
        await engine.dispose()
        print("service is stopped.")
