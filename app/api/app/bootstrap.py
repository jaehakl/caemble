"""Compose product policies and own application startup and shutdown."""

import asyncio
import logging
from contextlib import AsyncExitStack, asynccontextmanager, suppress

from caemble_catalog import Catalog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db import SessionLocal, engine
from gpstation.middleware import V1PublicCorsMiddleware
from gpstation.service.batches import fail_server_jobs
from gpstation.service.job_orchestrator import job_orchestrator
from gpstation.service.job_service import JobService
from gpstation.service.server_handlers import register_server_handler
from gpstation.service.state import runtime
from model_registry import register_models
from optimization import evaluation, integration
from optimization.controller import reconcile_once, start_controller, stop_controller
from settings import settings
from simulation.services import maintenance, recording
from simulation.services.preflight import expire_preflights
from storage.service import cleanup_objects

logger = logging.getLogger(__name__)


async def _cleanup_loop() -> None:
    while True:
        try:
            async with SessionLocal() as db:
                await expire_preflights(db)
                await cleanup_objects(db)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Provider errors can contain signed URLs; keep the log credential-free.
            logger.warning("Object storage cleanup failed; retrying next sweep")
        await asyncio.sleep(60)


async def _stop_task(task: asyncio.Task) -> None:
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


@asynccontextmanager
async def lifespan(app: FastAPI):
    if getattr(app.state, "running", False):
        raise RuntimeError("Application lifespan is already running.")
    app.state.running = True
    app.state.progress = 0
    try:
        async with AsyncExitStack() as cleanup:
            cleanup.push_async_callback(engine.dispose)
            catalog = Catalog.open_readonly()
            app.state.catalog = catalog
            cleanup.callback(catalog.close)
            cleanup.push_async_callback(runtime.close_all_launchers)
            for name, handler in (
                ("cae.simulation", recording),
                ("cae.evaluation.build", evaluation),
                ("cae.evaluation.calculate", evaluation),
                ("cae.evaluation.predict", evaluation),
            ):
                register_server_handler(
                    name, handler,
                    event_context=integration.event_context,
                    on_finished=integration.on_finished,
                )
            async with SessionLocal() as db:
                await JobService.recover_after_server_restart(db)
                await fail_server_jobs(db, detail="server restarted", restarting=True)
            await reconcile_once(catalog)
            try:
                await maintenance.expire_once()
            except Exception:
                logger.warning("Initial upload expiry failed; retrying in the maintenance loop")
            cleanup.push_async_callback(job_orchestrator.stop_dispatcher)
            await job_orchestrator.start_dispatcher()
            cleanup.push_async_callback(stop_controller)
            await start_controller(catalog)
            cleanup.push_async_callback(maintenance.stop)
            await maintenance.start()
            task = asyncio.create_task(_cleanup_loop(), name="object-storage-cleanup")
            cleanup.push_async_callback(_stop_task, task)
            yield
    finally:
        app.state.catalog = None
        app.state.running = False


def create_app() -> FastAPI:
    register_models()
    from calculation.routers import calculation, data as calculation_data
    from capabilities import router as capabilities_router
    from catalog.router import router as catalog_router
    from data_router import router as data_router
    from gpstation.routers import v1, web
    from gpstation_adapter import v1_router, web_router
    from optimization.router import router as optimization_router
    from optimization.predictor_jobs import router as evaluation_predictor_router
    from prediction.router import router as prediction_router
    from simulation.routers import (
        demo_experiment, execution, experiment, experiment_record, measurement, recorded_data,
    )
    from storage.router import router as storage_router
    from user_auth.access_key_routes import router as access_key_router
    from user_auth.routes import router as auth_router
    from user_auth.users_router import router as users_router

    app = FastAPI(lifespan=lifespan)
    for router in (
        auth_router, execution.router, optimization_router, evaluation_predictor_router, storage_router, prediction_router,
        data_router, capabilities_router, catalog_router, experiment.router,
        experiment_record.router, measurement.router, recorded_data.router,
        calculation.router, calculation_data.router, demo_experiment.router, users_router,
        web.router, web_router, v1.router, v1_router, access_key_router,
    ):
        app.include_router(router)
    origins = sorted({settings.app_base_url, *settings.allowed_app_origins})
    app.add_middleware(
        CORSMiddleware,
        allow_credentials=True,
        allow_origins=origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(V1PublicCorsMiddleware)
    return app
