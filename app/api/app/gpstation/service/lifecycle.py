from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import text

from db import SessionLocal, engine
from gpstation.service.job_orchestrator import job_orchestrator
from gpstation.service.job_service import JobService
from gpstation.service.state import runtime
from gpstation.utils.slave_registry import initialize_slave_registry


RUNTIME_ADVISORY_LOCK_ID = int.from_bytes(b"CAEMBLE1", "big")


@asynccontextmanager
async def gpstation_lifespan(app: FastAPI):
    app.state.progress = 0
    initialize_slave_registry()
    lock_connection = await engine.connect()
    lock_acquired = False
    try:
        lock_acquired = bool(
            await lock_connection.scalar(
                text("SELECT pg_try_advisory_lock(:lock_id)"),
                {"lock_id": RUNTIME_ADVISORY_LOCK_ID},
            )
        )
        await lock_connection.commit()
        if not lock_acquired:
            raise RuntimeError(
                "Caemble job runtime is already active; run the API with one worker"
            )

        async with SessionLocal() as db:
            await JobService.recover_after_server_restart(db)
        await job_orchestrator.start_dispatcher()
        print("service is started.")
        yield
    finally:
        await job_orchestrator.stop_dispatcher()
        await runtime.close_all_launchers()
        if lock_acquired:
            await lock_connection.scalar(
                text("SELECT pg_advisory_unlock(:lock_id)"),
                {"lock_id": RUNTIME_ADVISORY_LOCK_ID},
            )
            await lock_connection.commit()
        await lock_connection.close()
        await engine.dispose()
        print("service is stopped.")
