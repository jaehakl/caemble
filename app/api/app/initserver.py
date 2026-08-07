from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from db import SessionLocal, engine
from runtime_state import runtime
from service.job_orchestrator import job_orchestrator
from service.job_service import JobService
from settings import settings
from slave_registry import initialize_slave_registry
from user_auth.routes import router as auth_router


RUNTIME_ADVISORY_LOCK_ID = int.from_bytes(b"CAEMBLE1", "big")
V1_CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT",
    "Access-Control-Max-Age": "600",
}


class V1PublicCorsMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not str(scope.get("path", "")).startswith("/v1/"):
            await self.app(scope, receive, send)
            return

        request_headers = Headers(scope=scope)
        if not request_headers.get("origin"):
            await self.app(scope, receive, send)
            return

        allow_headers = (
            request_headers.get("access-control-request-headers")
            or "authorization, content-type"
        )
        cors_headers = {
            **V1_CORS_HEADERS,
            "Access-Control-Allow-Headers": allow_headers,
        }
        if (
            scope.get("method") == "OPTIONS"
            and request_headers.get("access-control-request-method")
        ):
            await Response(status_code=200, headers=cors_headers)(scope, receive, send)
            return

        async def send_with_cors(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if "Access-Control-Allow-Credentials" in headers:
                    del headers["Access-Control-Allow-Credentials"]
                for name, value in cors_headers.items():
                    headers[name] = value
            await send(message)

        await self.app(scope, receive, send_with_cors)


def server() -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
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

    app = FastAPI(lifespan=lifespan)
    app.include_router(auth_router)

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
