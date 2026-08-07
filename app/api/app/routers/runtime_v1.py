from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import urlparse, urlunparse

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from db import SessionLocal
from models import (
    JobAnswerWaitResult,
    JobCreateRequest,
    JobCreateResult,
    JobData,
    LauncherView,
    OkResponse,
)
from runtime_auth import Principal, authenticate_db_authorization, require_client
from runtime_state import runtime, utcnow
from sdk.protocol.messages import LauncherHello, parse_launcher_message
from service.access_key_service import AccessKeyService
from service.auth_audit_service import add_auth_audit
from service.job_orchestrator import LauncherPolicyViolation, job_orchestrator
from service.job_service import JobService, job_to_data
from service.launcher_service import LauncherService
from settings import settings
from slave_registry import registered_slave_app_ids
from user_auth.routes import get_db


router = APIRouter(prefix="/v1")
LAUNCHER_HELLO_TIMEOUT_SECONDS = 10


@router.get("/launchers", response_model=list[LauncherView], tags=["v1-launchers"])
async def list_launchers(
    principal: Principal = Depends(require_client),
    db: AsyncSession = Depends(get_db),
) -> list[LauncherView]:
    return await LauncherService.list_launchers_for_user(db, principal.user_id)


@router.websocket("/launchers/control")
async def launcher_control(websocket: WebSocket) -> None:
    launcher_id: str | None = None
    principal: Principal | None = None
    async with SessionLocal() as db:
        try:
            try:
                principal = await authenticate_db_authorization(
                    db,
                    websocket.headers.get("authorization", ""),
                    client_ip=websocket.client.host if websocket.client else None,
                    origin=websocket.headers.get("origin"),
                )
                principal.require_scope("launcher")
            except HTTPException as error:
                add_auth_audit(
                    db,
                    "launcher_rejected",
                    user_id=principal.user_id if principal else None,
                    details={
                        "reason": "missing_launcher_scope" if principal else "authentication_failed",
                        "status_code": error.status_code,
                        "access_key_id": principal.access_key_id if principal else None,
                    },
                    client_ip=websocket.client.host if websocket.client else None,
                    user_agent=websocket.headers.get("user-agent"),
                )
                await db.commit()
                await websocket.accept()
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                return

            await db.rollback()
            await websocket.accept()
            hello_payload = await asyncio.wait_for(
                websocket.receive_json(),
                timeout=LAUNCHER_HELLO_TIMEOUT_SECONDS,
            )
            hello = parse_launcher_message(hello_payload)
            if not isinstance(hello, LauncherHello):
                add_auth_audit(
                    db,
                    "launcher_rejected",
                    user_id=principal.user_id,
                    details={
                        "reason": "invalid_hello",
                        "access_key_id": principal.access_key_id,
                    },
                    client_ip=websocket.client.host if websocket.client else None,
                    user_agent=websocket.headers.get("user-agent"),
                )
                await db.commit()
                await websocket.close(code=status.WS_1003_UNSUPPORTED_DATA)
                return
            unknown_apps = sorted(set(hello.slave_app_ids) - set(registered_slave_app_ids()))
            if unknown_apps:
                add_auth_audit(
                    db,
                    "launcher_rejected",
                    user_id=principal.user_id,
                    details={
                        "reason": "unknown_slave_app_ids",
                        "slave_app_ids": unknown_apps,
                        "access_key_id": principal.access_key_id,
                    },
                    client_ip=websocket.client.host if websocket.client else None,
                    user_agent=websocket.headers.get("user-agent"),
                )
                await db.commit()
                await safe_send_json(
                    websocket,
                    {
                        "type": "error",
                        "detail": f"unknown slave_app_ids: {', '.join(unknown_apps)}",
                    },
                )
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                return

            launcher = await LauncherService.create_connected_launcher(
                db,
                user_id=principal.user_id,
                launcher_name=hello.launcher_name,
                slave_app_ids=hello.slave_app_ids,
                ip_address=websocket.client.host if websocket.client else None,
            )
            launcher_id = str(launcher.id)
            await runtime.register_launcher(
                launcher_id,
                websocket,
                principal.access_key_id,
            )
            add_auth_audit(
                db,
                "launcher_connected",
                user_id=principal.user_id,
                details={
                    "launcher_id": launcher_id,
                    "access_key_id": principal.access_key_id,
                },
                client_ip=websocket.client.host if websocket.client else None,
                user_agent=websocket.headers.get("user-agent"),
            )
            await db.commit()
            await websocket.send_json(
                {
                    "type": "launcher.accepted",
                    "launcher_id": launcher_id,
                    "server_time": utcnow().isoformat(),
                }
            )
            job_orchestrator.wake_dispatcher()

            while True:
                payload = await websocket.receive_json()
                await handle_launcher_message(
                    db,
                    launcher_id,
                    principal.user_id,
                    payload,
                )
        except WebSocketDisconnect:
            pass
        except TimeoutError:
            add_auth_audit(
                db,
                "launcher_rejected",
                user_id=principal.user_id if principal else None,
                details={
                    "reason": "hello_timeout",
                    "access_key_id": principal.access_key_id if principal else None,
                },
                client_ip=websocket.client.host if websocket.client else None,
                user_agent=websocket.headers.get("user-agent"),
            )
            await db.commit()
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        except ValidationError as error:
            await db.rollback()
            add_auth_audit(
                db,
                "launcher_rejected",
                user_id=principal.user_id if principal else None,
                details={
                    "reason": "invalid_message",
                    "launcher_id": launcher_id,
                    "detail": str(error)[:512],
                },
                client_ip=websocket.client.host if websocket.client else None,
                user_agent=websocket.headers.get("user-agent"),
            )
            await db.commit()
            await safe_send_json(websocket, {"type": "error", "detail": str(error)})
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        except LauncherPolicyViolation as error:
            await db.rollback()
            add_auth_audit(
                db,
                "launcher_rejected",
                user_id=principal.user_id if principal else None,
                details={
                    "reason": "policy_violation",
                    "launcher_id": launcher_id,
                    "detail": str(error)[:512],
                },
                client_ip=websocket.client.host if websocket.client else None,
                user_agent=websocket.headers.get("user-agent"),
            )
            await db.commit()
            await safe_send_json(websocket, {"type": "error", "detail": str(error)})
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        finally:
            if launcher_id is not None:
                await db.rollback()
                await job_orchestrator.launcher_disconnected(db, launcher_id=launcher_id)
                add_auth_audit(
                    db,
                    "launcher_disconnected",
                    user_id=principal.user_id if principal else None,
                    details={"launcher_id": launcher_id},
                    client_ip=websocket.client.host if websocket.client else None,
                    user_agent=websocket.headers.get("user-agent"),
                )
                await db.commit()


async def handle_launcher_message(
    db: AsyncSession,
    launcher_id: str,
    user_id: str,
    payload: dict[str, Any],
) -> None:
    message = parse_launcher_message(payload)
    if message.type == "launcher.heartbeat":
        persist_heartbeat, revalidate_key = await runtime.heartbeat_actions(
            launcher_id,
            message.status,
        )
        if revalidate_key:
            launcher = await runtime.get_launcher(launcher_id)
            access_key_id = launcher.access_key_id if launcher is not None else None
            key_is_active = access_key_id is not None and await AccessKeyService.is_active_launcher_key(
                db,
                access_key_id,
                user_id,
            )
            if not key_is_active:
                add_auth_audit(
                    db,
                    "launcher_rejected",
                    user_id=user_id,
                    details={
                        "launcher_id": launcher_id,
                        "reason": "access_key_inactive",
                    },
                )
                await db.commit()
                raise LauncherPolicyViolation("launcher access key is no longer active")
            await db.rollback()
        await runtime.mark_heartbeat(
            launcher_id,
            loaded_slave_app_id=message.loaded_slave_app_id,
            worker_status=message.worker_status,
            metadata=message.metadata,
        )
        if persist_heartbeat:
            await LauncherService.mark_heartbeat(db, launcher_id, message.status)
        return
    await job_orchestrator.handle_launcher_job_event(
        db,
        launcher_id=launcher_id,
        user_id=user_id,
        message=message,
    )


@router.post("/jobs", response_model=JobCreateResult, tags=["v1-jobs"])
async def create_job(
    body: JobCreateRequest,
    principal: Principal = Depends(require_client),
    db: AsyncSession = Depends(get_db),
) -> JobCreateResult:
    try:
        job = await job_orchestrator.create_job(
            db,
            user_id=principal.user_id,
            handler_type=body.handler_type,
            slave_app_id=body.slave_app_id,
            offer=body.offer,
        )
    except (ValueError, ValidationError) as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    return JobCreateResult(
        job=job_to_data(job),
        answer_wait_url=build_job_wait_url(str(job.id), "/v1/jobs"),
    )


@router.get("/jobs/{job_id}", response_model=JobData, tags=["v1-jobs"])
async def get_job(
    job_id: str,
    principal: Principal = Depends(require_client),
    db: AsyncSession = Depends(get_db),
) -> JobData:
    job = await JobService.get_job(db, job_id=job_id, user_id=principal.user_id)
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    return job_to_data(job)


@router.get(
    "/jobs/{job_id}/wait-answer",
    response_model=JobAnswerWaitResult,
    tags=["v1-jobs"],
)
async def wait_job_answer(
    job_id: str,
    wait_seconds: float = Query(default=30.0, ge=0, le=60),
    principal: Principal = Depends(require_client),
    db: AsyncSession = Depends(get_db),
) -> JobAnswerWaitResult:
    job = await job_orchestrator.wait_for_answer(
        db,
        job_id=job_id,
        user_id=principal.user_id,
        wait_seconds=wait_seconds,
    )
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    return JobAnswerWaitResult(
        job_id=str(job.id),
        state=job.state,
        answer=job.answer,
        last_error=job.last_error,
    )


@router.post("/jobs/{job_id}/kill", response_model=OkResponse, tags=["v1-jobs"])
async def kill_job(
    job_id: str,
    principal: Principal = Depends(require_client),
    db: AsyncSession = Depends(get_db),
) -> OkResponse:
    job = await job_orchestrator.kill_job(
        db,
        job_id=job_id,
        user_id=principal.user_id,
        reason="killed by client",
    )
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    return OkResponse()


def build_job_wait_url(job_id: str, prefix: str) -> str:
    parsed = urlparse(settings.public_api_base_url)
    base_path = parsed.path.rstrip("/")
    path = f"{base_path}{prefix}/{job_id}/wait-answer"
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


async def safe_send_json(websocket: WebSocket, message: dict[str, Any]) -> None:
    try:
        await websocket.send_json(message)
    except RuntimeError:
        pass
