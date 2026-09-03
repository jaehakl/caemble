from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
import uuid
from typing import Any

from caemble_catalog import Catalog
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ai.agent import AgentRunner, permission_fingerprint
from ai.credentials import get_provider_credential, router as credential_router
from ai.data_tools import VisibleDataReader
from ai.models import RunCancel, RunStart, parse_client_message
from ai.provider import ProviderError, create_provider_adapter
from ai.session import SessionEnvelopeCodec, SessionEnvelopeError
from ai.tools import ToolExecutor
from ai.workspace import StagedCalculation, StagedExperiment, WorkspaceEditError
from db import Calculation, Experiment, ExperimentDemo
from models import UserData
from settings import settings
from user_auth.routes import check_user, get_db
from utils.crud.common import is_admin_user


logger = logging.getLogger(__name__)

router = APIRouter()
router.include_router(credential_router)

_active_user_runs: set[str] = set()
_active_user_runs_lock = threading.Lock()


class WebSocketEventEmitter:
    def __init__(self, websocket: WebSocket, run_id: str):
        self.websocket = websocket
        self.run_id = run_id
        self.sequence = 0
        self._send_lock = asyncio.Lock()
        self._workspace: StagedExperiment | StagedCalculation | None = None
        self._staged_revision = 0
        self._source_hash: str | None = None

    def set_workspace_identity(self, staged_revision: int, source_hash: str) -> None:
        self._staged_revision = staged_revision
        self._source_hash = source_hash

    def bind_workspace(self, workspace: StagedExperiment | StagedCalculation) -> None:
        self._workspace = workspace

    async def emit(self, event_type: str, **payload: Any) -> None:
        async with self._send_lock:
            self.sequence += 1
            staged_revision = (
                self._workspace.revision if self._workspace is not None else self._staged_revision
            )
            source_hash = (
                self._workspace.source_hash if self._workspace is not None else self._source_hash
            )
            payload.setdefault("stagedRevision", staged_revision)
            if source_hash is not None:
                payload.setdefault("sourceHash", source_hash)
            await self.websocket.send_json(
                {
                    "type": event_type,
                    "runId": self.run_id,
                    "sequence": self.sequence,
                    **payload,
                }
            )


@router.websocket("/ai/agent/run")
async def run_agent(
    websocket: WebSocket,
    db: AsyncSession = Depends(get_db),
) -> None:
    if not _trusted_origin(websocket.headers.get("origin")) or not websocket.cookies.get(
        "access_token"
    ):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    try:
        user = await check_user(websocket, db)  # WebSocket exposes the Request auth surface.
    except HTTPException:
        await db.rollback()
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    await db.rollback()

    user_id = user.id
    if not _claim_user_run(user_id):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    try:
        await websocket.accept()
    except Exception:
        _release_user_run(user_id)
        raise
    run_task: asyncio.Task[dict[str, Any]] | None = None
    provider: Any = None
    cancel_event = asyncio.Event()
    emitter: WebSocketEventEmitter | None = None
    started_at: float | None = None
    start_message: RunStart | None = None
    try:
        first = await _receive_message(websocket)
        if not isinstance(first, RunStart):
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        run_id = uuid.uuid4().hex
        first = await _authorize_calculation_workspace(db, user, first)
        await db.rollback()
        start_message = first
        started_at = time.perf_counter()
        emitter = WebSocketEventEmitter(websocket, run_id)
        emitter.set_workspace_identity(0, first.workspace.baseHash)
        document = first.workspace.document
        workspace = (
            StagedExperiment(document.sourceBundle)
            if document.kind == "experiment"
            else StagedCalculation(
                calculation_id=document.calculationId,
                experiment_id=document.experimentId,
                name=document.name,
                description=document.description,
                source_code=document.sourceCode,
                editable=document.editable,
                reference_experiment=document.referenceExperiment.sourceBundle,
            )
        )
        emitter.bind_workspace(workspace)
        await emitter.emit("run.started", status="started")
        logger.info(
            "ai_agent.run.started",
            extra={
                "ai_run_id": run_id,
                "ai_user_id": user_id,
                "ai_provider": first.provider,
                "ai_model": first.model,
            },
        )

        try:
            api_key, credential_version = await get_provider_credential(
                db,
                user.id,
                first.provider,
            )
        finally:
            await db.rollback()
        keys = [key.get_secret_value() for key in settings.AI_CREDENTIAL_FERNET_KEYS]
        session_codec = SessionEnvelopeCodec(keys)
        catalog = getattr(websocket.app.state, "catalog", None)
        if not isinstance(catalog, Catalog):
            raise RuntimeError("Catalog is unavailable")
        provider = create_provider_adapter(first.provider, first.model, api_key)
        roles = [role.value if hasattr(role, "value") else str(role) for role in user.roles]
        tools = ToolExecutor(
            data=VisibleDataReader(db, user.id),
            catalog=catalog,
            workspace=workspace,
        )
        runner = AgentRunner(
            run_id=run_id,
            user_id=user.id,
            credential_version=credential_version,
            permission_fingerprint=permission_fingerprint(user.id, roles),
            start=first,
            workspace=workspace,
            provider=provider,
            tools=tools,
            session_codec=session_codec,
            emitter=emitter,
            cancel_event=cancel_event,
        )
        run_task = asyncio.create_task(runner.run(api_key))
        result = await _drive_run(websocket, run_task, cancel_event, run_id)
        await emitter.emit("run.completed", **result)
        context_usage = result["contextUsage"]
        logger.info(
            "ai_agent.run.completed",
            extra={
                "ai_run_id": run_id,
                "ai_user_id": user_id,
                "ai_provider": first.provider,
                "ai_model": first.model,
                "ai_latency_ms": round((time.perf_counter() - started_at) * 1000, 2),
                "ai_tool_count": runner.tool_count,
                "ai_input_tokens": context_usage["inputTokens"],
                "ai_output_tokens": context_usage["outputTokens"],
                "ai_cached_tokens": context_usage["cachedTokens"],
                "ai_cache_write_tokens": context_usage["cacheWriteTokens"],
                "ai_compacted": context_usage["compacted"],
            },
        )
        await websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
    except (WebSocketDisconnect, asyncio.CancelledError):
        cancel_event.set()
        if run_task is not None and not run_task.done():
            run_task.cancel()
        if emitter is not None:
            try:
                await emitter.emit("run.cancelled", message="Agent run was cancelled")
                await websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
            except (RuntimeError, WebSocketDisconnect):
                pass
        logger.info(
            "ai_agent.run.cancelled",
            extra={
                "ai_run_id": emitter.run_id if emitter is not None else None,
                "ai_user_id": user_id,
                "ai_provider": start_message.provider if start_message is not None else None,
                "ai_model": start_message.model if start_message is not None else None,
                "ai_latency_ms": (
                    round((time.perf_counter() - started_at) * 1000, 2)
                    if started_at is not None
                    else None
                ),
            },
        )
    except Exception as error:
        cancel_event.set()
        if run_task is not None and not run_task.done():
            run_task.cancel()
        if emitter is not None:
            try:
                failure = {"message": _safe_error_message(error)}
                if isinstance(error, ProviderError) and error.code is not None:
                    failure.update(error.public_data())
                await emitter.emit("run.failed", **failure)
                await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
            except (RuntimeError, WebSocketDisconnect):
                pass
        else:
            try:
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            except RuntimeError:
                pass
        failure_log = {
            "ai_run_id": emitter.run_id if emitter is not None else None,
            "ai_user_id": user_id,
            "ai_provider": start_message.provider if start_message is not None else None,
            "ai_model": start_message.model if start_message is not None else None,
            "ai_error_code": (
                error.code
                if isinstance(error, ProviderError) and error.code is not None
                else type(error).__name__
            ),
            "ai_latency_ms": (
                round((time.perf_counter() - started_at) * 1000, 2)
                if started_at is not None
                else None
            ),
        }
        if isinstance(error, ProviderError):
            failure_log.update(
                ai_provider_status=error.status_code,
                ai_provider_error_code=error.upstream_code,
                ai_provider_parameter=error.parameter,
                ai_provider_request_id=error.request_id,
            )
        logger.warning("ai_agent.run.failed", extra=failure_log)
    finally:
        if run_task is not None and not run_task.done():
            run_task.cancel()
        if run_task is not None:
            await asyncio.gather(run_task, return_exceptions=True)
        if provider is not None:
            try:
                await provider.close()
            except Exception:
                logger.warning(
                    "ai_agent.provider_close.failed",
                    extra={"ai_error_code": "provider_close_failed"},
                )
        try:
            await db.rollback()
        finally:
            _release_user_run(user_id)


async def _drive_run(
    websocket: WebSocket,
    run_task: asyncio.Task[dict[str, Any]],
    cancel_event: asyncio.Event,
    run_id: str,
) -> dict[str, Any]:
    while True:
        receive_task = asyncio.create_task(_receive_message(websocket))
        done, _ = await asyncio.wait(
            {run_task, receive_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if run_task in done:
            receive_task.cancel()
            await asyncio.gather(receive_task, return_exceptions=True)
            return await run_task
        message = await receive_task
        if isinstance(message, RunCancel) and message.runId == run_id:
            cancel_event.set()
            run_task.cancel()
            raise asyncio.CancelledError


async def _receive_message(websocket: WebSocket) -> Any:
    envelope = await websocket.receive()
    if envelope.get("type") == "websocket.disconnect":
        raise WebSocketDisconnect(envelope.get("code", status.WS_1000_NORMAL_CLOSURE))
    text = envelope.get("text")
    if not isinstance(text, str):
        raise ValueError("Binary WebSocket messages are not supported")
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError("WebSocket message must be valid JSON") from error
    return parse_client_message(value)


def _trusted_origin(origin: str | None) -> bool:
    if origin is None:
        return False
    allowed = {settings.app_base_url.rstrip("/"), *(value.rstrip("/") for value in settings.allowed_app_origins)}
    return origin in allowed


def _claim_user_run(user_id: str) -> bool:
    with _active_user_runs_lock:
        if user_id in _active_user_runs:
            return False
        _active_user_runs.add(user_id)
        return True


def _release_user_run(user_id: str) -> None:
    with _active_user_runs_lock:
        _active_user_runs.discard(user_id)


def _safe_error_message(error: Exception) -> str:
    if isinstance(error, ValidationError):
        return "WebSocket message does not match the Agent protocol"
    if isinstance(
        error,
        (
            ProviderError,
            SessionEnvelopeError,
            WorkspaceEditError,
            ValueError,
        ),
    ):
        return str(error)
    if isinstance(error, LookupError):
        return "An API credential is not configured for this provider"
    if isinstance(error, RuntimeError) and str(error) == "Catalog is unavailable":
        return str(error)
    if isinstance(error, TimeoutError):
        return "The AI Agent run timed out"
    return "The AI Agent run failed"


async def _authorize_calculation_workspace(
    db: AsyncSession,
    user: UserData,
    start: RunStart,
) -> RunStart:
    document = start.workspace.document
    if document.kind != "calculation":
        return start
    experiment = (
        await db.execute(
            select(
                Experiment.id,
                Experiment.user_id,
                ExperimentDemo.experiment_id.label("demo_experiment_id"),
            )
            .outerjoin(ExperimentDemo, ExperimentDemo.experiment_id == Experiment.id)
            .where(Experiment.id == document.experimentId)
        )
    ).mappings().one_or_none()
    admin = is_admin_user(user)
    demo = experiment is not None and experiment["demo_experiment_id"] is not None
    if experiment is None or not (
        admin or experiment["user_id"] is None or experiment["user_id"] == user.id or demo
    ):
        raise WorkspaceEditError("Calculation Experiment is not visible")
    editable = admin or experiment["user_id"] == user.id or demo
    updates: dict[str, Any] = {"editable": editable}
    if document.calculationId is not None:
        calculation = (
            await db.execute(
                select(Calculation.name, Calculation.description).where(
                    Calculation.id == document.calculationId,
                    Calculation.experiment_id == document.experimentId,
                )
            )
        ).mappings().one_or_none()
        if calculation is None:
            raise WorkspaceEditError("Calculation was not found in this Experiment")
        updates.update(
            name=calculation["name"],
            description=calculation["description"] or "",
        )
    authorized_document = document.model_copy(update=updates)
    return start.model_copy(
        update={"workspace": start.workspace.model_copy(update={"document": authorized_document})}
    )
