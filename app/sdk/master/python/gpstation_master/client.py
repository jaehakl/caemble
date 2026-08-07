from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Hashable, Literal, overload
from urllib.parse import quote

import httpx
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

from .constants import DATA_CHANNEL_LABEL
from .diagnostics import (
    DiagnosticCallback,
    emit_diagnostic,
    register_connection_diagnostics,
    register_prepared_connection_diagnostics,
)
from .errors import GpStationError, GpStationHttpError, GpStationProtocolError
from .job_peer import EventCallback, GpStationJobPeer
from .rtc import (
    PreparedJobConnection,
    close_peer_connection,
    create_prepared_job_connection,
    job_connection_key,
    rtc_configuration_with_defaults,
    summarize_sdp_candidates,
)
from .types import (
    CallResult,
    ConnectDiagnosticEvent,
    JobAnswerWaitResult,
    JobCreateResult,
    JobDescriptor,
    JobEvent,
    LauncherView,
    RequestAttachment,
    RunJobSessionResult,
    SignalPayload,
)


StatusCallback = Callable[[str], None]
JobCreatedCallback = Callable[[JobDescriptor], None]


class _RunJobAttemptError(GpStationError):
    def __init__(self, message: str, job_id: str | None, input_sent: bool) -> None:
        self.job_id = job_id
        self.input_sent = input_sent
        super().__init__(message)


class GpStationJobSession:
    def __init__(
        self,
        job_id: str,
        peer: GpStationJobPeer,
        default_timeout_seconds: float,
        default_on_event: EventCallback | None = None,
        on_closed: Callable[[GpStationJobSession], None] | None = None,
    ) -> None:
        self.job_id = job_id
        self._peer = peer
        self._default_timeout_seconds = default_timeout_seconds
        self._default_on_event = default_on_event
        self._on_closed = on_closed
        self._call_index = 0
        self._closed_notified = False

    @property
    def closed(self) -> bool:
        return self._peer.closed

    async def call(
        self,
        handler_type: str,
        input: Any = None,
        *,
        timeout_seconds: float | None = None,
        on_event: EventCallback | None = None,
        attachments: Sequence[RequestAttachment] = (),
    ) -> CallResult[Any]:
        effective_timeout = (
            self._default_timeout_seconds if timeout_seconds is None else timeout_seconds
        )
        if effective_timeout <= 0:
            raise ValueError("timeout_seconds must be greater than zero")
        self._call_index += 1
        call_id = self.job_id if self._call_index == 1 else f"{self.job_id}:{self._call_index}"

        def dispatch_event(event: JobEvent) -> None:
            if self._default_on_event is not None:
                self._default_on_event(event)
            if on_event is not None and on_event is not self._default_on_event:
                on_event(event)

        return await self._peer.call(
            call_id,
            handler_type,
            input,
            effective_timeout,
            dispatch_event,
            attachments,
        )

    async def finish(self, *, timeout_seconds: float | None = None) -> None:
        if self.closed:
            await self._peer.close()
            self._notify_closed()
            return
        effective_timeout = (
            self._default_timeout_seconds if timeout_seconds is None else timeout_seconds
        )
        if effective_timeout <= 0:
            raise ValueError("timeout_seconds must be greater than zero")
        await self._peer.finish(self.job_id, effective_timeout)
        self._notify_closed()

    async def close(self) -> None:
        await self._peer.close()
        self._notify_closed()

    def _notify_closed(self) -> None:
        if self._closed_notified:
            return
        self._closed_notified = True
        if self._on_closed is not None:
            self._on_closed(self)


class GpStationClient:
    def __init__(
        self,
        api_base_url: str,
        token: str | None = None,
        *,
        auth_mode: Literal["bearer", "cookie"] = "bearer",
        job_api_prefix: str = "/v1/jobs",
        rtc_configuration: RTCConfiguration | None = None,
        cookies: Mapping[str, str] | httpx.Cookies | None = None,
    ) -> None:
        api_base_url = api_base_url.rstrip("/")
        if not api_base_url:
            raise ValueError("api_base_url is required")
        if auth_mode not in {"bearer", "cookie"}:
            raise ValueError("auth_mode must be 'bearer' or 'cookie'")
        if auth_mode == "bearer" and not token:
            raise ValueError("token is required for bearer authentication")
        self._api_base_url = api_base_url
        self._token = token
        self._auth_mode = auth_mode
        self._job_api_prefix = _normalize_api_prefix(job_api_prefix)
        self._rtc_configuration = rtc_configuration
        self._http_client = httpx.AsyncClient(
            cookies=cookies,
            timeout=httpx.Timeout(65.0, connect=10.0),
        )
        self._prewarmed_connections: dict[Hashable, PreparedJobConnection] = {}
        self._prewarm_tasks: dict[Hashable, asyncio.Task[PreparedJobConnection]] = {}
        self._background_tasks: set[asyncio.Task[None]] = set()
        self._prewarm_lock = asyncio.Lock()
        self._active_sessions: set[GpStationJobSession] = set()
        self._active_peers: set[GpStationJobPeer] = set()
        self._csrf_token: str | None = None
        self._csrf_lock = asyncio.Lock()
        self._closed = False

    async def __aenter__(self) -> GpStationClient:
        self._ensure_open()
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        background_tasks = list(self._background_tasks)
        for task in background_tasks:
            task.cancel()
        async with self._prewarm_lock:
            prewarm_tasks = list(self._prewarm_tasks.values())
            self._prewarm_tasks.clear()
            prepared = list(self._prewarmed_connections.values())
            self._prewarmed_connections.clear()
        for task in prewarm_tasks:
            task.cancel()
        if background_tasks or prewarm_tasks:
            await asyncio.gather(*background_tasks, *prewarm_tasks, return_exceptions=True)
        sessions = list(self._active_sessions)
        peers = list(self._active_peers)
        if sessions or peers:
            await asyncio.gather(
                *(session.close() for session in sessions),
                *(peer.close() for peer in peers),
                return_exceptions=True,
            )
        if prepared:
            await asyncio.gather(
                *(close_peer_connection(item.peer_connection, item.data_channel) for item in prepared),
                return_exceptions=True,
            )
        await self._http_client.aclose()

    async def list_launchers(self) -> list[LauncherView]:
        self._ensure_open()
        payload = await self._request("/v1/launchers")
        if not isinstance(payload, list):
            raise GpStationProtocolError("launcher list response must be an array")
        return [_parse_launcher(item) for item in payload]

    async def prewarm_job_connection(
        self,
        *,
        slave_app_id: str = "ai",
        rtc_configuration: RTCConfiguration | None = None,
        timeout_seconds: float = 60.0,
        on_diagnostic: DiagnosticCallback | None = None,
    ) -> None:
        self._ensure_open()
        _validate_run_parameters("prewarm", slave_app_id, timeout_seconds)
        configuration = rtc_configuration_with_defaults(rtc_configuration or self._rtc_configuration)
        key = job_connection_key(slave_app_id, configuration)
        stale: PreparedJobConnection | None = None
        async with self._prewarm_lock:
            existing = self._prewarmed_connections.get(key)
            if existing is not None and _prepared_is_usable(existing):
                return
            if existing is not None:
                stale = self._prewarmed_connections.pop(key)
            task = self._prewarm_tasks.get(key)
            if task is None:
                task = asyncio.create_task(
                    self._build_prepared_connection(
                        slave_app_id,
                        configuration,
                        timeout_seconds,
                        on_diagnostic,
                    )
                )
                self._prewarm_tasks[key] = task
        if stale is not None:
            await close_peer_connection(stale.peer_connection, stale.data_channel)
        try:
            prepared = await asyncio.shield(task)
        except Exception:
            async with self._prewarm_lock:
                if self._prewarm_tasks.get(key) is task:
                    self._prewarm_tasks.pop(key, None)
            raise
        close_prepared = False
        async with self._prewarm_lock:
            if self._prewarm_tasks.get(key) is task:
                self._prewarm_tasks.pop(key, None)
            existing = self._prewarmed_connections.get(key)
            if self._closed:
                close_prepared = True
            elif existing is None:
                self._prewarmed_connections[key] = prepared
            elif existing is not prepared:
                close_prepared = True
        if close_prepared:
            await close_peer_connection(prepared.peer_connection, prepared.data_channel)

    async def clear_prewarmed_job_connections(self) -> None:
        background_tasks = list(self._background_tasks)
        for task in background_tasks:
            task.cancel()
        async with self._prewarm_lock:
            prewarm_tasks = list(self._prewarm_tasks.values())
            self._prewarm_tasks.clear()
            prepared = list(self._prewarmed_connections.values())
            self._prewarmed_connections.clear()
        for task in prewarm_tasks:
            task.cancel()
        if background_tasks or prewarm_tasks:
            await asyncio.gather(*background_tasks, *prewarm_tasks, return_exceptions=True)
        if prepared:
            await asyncio.gather(
                *(close_peer_connection(item.peer_connection, item.data_channel) for item in prepared),
                return_exceptions=True,
            )

    @overload
    async def run_job(
        self,
        handler_type: str,
        input: Any = None,
        *,
        slave_app_id: str = "ai",
        timeout_seconds: float = 60.0,
        rtc_configuration: RTCConfiguration | None = None,
        auto_finish: Literal[True] = True,
        on_status: StatusCallback | None = None,
        on_diagnostic: DiagnosticCallback | None = None,
        on_job_created: JobCreatedCallback | None = None,
        on_event: EventCallback | None = None,
        attachments: Sequence[RequestAttachment] = (),
    ) -> CallResult[Any]: ...

    @overload
    async def run_job(
        self,
        handler_type: str,
        input: Any = None,
        *,
        slave_app_id: str = "ai",
        timeout_seconds: float = 60.0,
        rtc_configuration: RTCConfiguration | None = None,
        auto_finish: Literal[False],
        on_status: StatusCallback | None = None,
        on_diagnostic: DiagnosticCallback | None = None,
        on_job_created: JobCreatedCallback | None = None,
        on_event: EventCallback | None = None,
        attachments: Sequence[RequestAttachment] = (),
    ) -> RunJobSessionResult[Any]: ...

    async def run_job(
        self,
        handler_type: str,
        input: Any = None,
        *,
        slave_app_id: str = "ai",
        timeout_seconds: float = 60.0,
        rtc_configuration: RTCConfiguration | None = None,
        auto_finish: bool = True,
        on_status: StatusCallback | None = None,
        on_diagnostic: DiagnosticCallback | None = None,
        on_job_created: JobCreatedCallback | None = None,
        on_event: EventCallback | None = None,
        attachments: Sequence[RequestAttachment] = (),
    ) -> CallResult[Any] | RunJobSessionResult[Any]:
        self._ensure_open()
        _validate_run_parameters(handler_type, slave_app_id, timeout_seconds)
        configuration = rtc_configuration_with_defaults(rtc_configuration or self._rtc_configuration)
        try:
            try:
                return await self._run_job_attempt(
                    handler_type,
                    input,
                    slave_app_id=slave_app_id,
                    timeout_seconds=timeout_seconds,
                    rtc_configuration=configuration,
                    auto_finish=auto_finish,
                    on_status=on_status,
                    on_diagnostic=on_diagnostic,
                    on_job_created=on_job_created,
                    on_event=on_event,
                    attachments=attachments,
                    attempt=0,
                )
            except _RunJobAttemptError as error:
                if error.input_sent:
                    if on_diagnostic is not None:
                        on_diagnostic(
                            ConnectDiagnosticEvent(
                                stage="job-retry",
                                message="retry skipped after job call sent",
                            )
                        )
                    raise GpStationError(str(error)) from error
                if on_diagnostic is not None:
                    on_diagnostic(
                        ConnectDiagnosticEvent(
                            stage="job-retry",
                            message="retry attempt=1",
                            elapsed_ms=0,
                        )
                    )
                await self._kill_job_best_effort(error.job_id)
                try:
                    return await self._run_job_attempt(
                        handler_type,
                        input,
                        slave_app_id=slave_app_id,
                        timeout_seconds=timeout_seconds,
                        rtc_configuration=configuration,
                        auto_finish=auto_finish,
                        on_status=on_status,
                        on_diagnostic=on_diagnostic,
                        on_job_created=on_job_created,
                        on_event=on_event,
                        attachments=attachments,
                        attempt=1,
                    )
                except _RunJobAttemptError as retry_error:
                    raise GpStationError(str(retry_error)) from retry_error
        finally:
            if auto_finish and not self._closed:
                self._schedule_prewarm(
                    slave_app_id,
                    configuration,
                    timeout_seconds,
                    on_diagnostic,
                )

    async def _run_job_attempt(
        self,
        handler_type: str,
        input: Any,
        *,
        slave_app_id: str,
        timeout_seconds: float,
        rtc_configuration: RTCConfiguration,
        auto_finish: bool,
        on_status: StatusCallback | None,
        on_diagnostic: DiagnosticCallback | None,
        on_job_created: JobCreatedCallback | None,
        on_event: EventCallback | None,
        attachments: Sequence[RequestAttachment],
        attempt: int,
    ) -> CallResult[Any] | RunJobSessionResult[Any]:
        prepared = await self._take_prepared_connection(slave_app_id, rtc_configuration)
        prewarm_hit = prepared is not None
        peer_connection = prepared.peer_connection if prepared else RTCPeerConnection(rtc_configuration)
        data_channel = (
            prepared.data_channel
            if prepared
            else peer_connection.createDataChannel(DATA_CHANNEL_LABEL, ordered=True)
        )
        peer = GpStationJobPeer(peer_connection, data_channel, on_diagnostic)
        self._active_peers.add(peer)
        if prepared is not None:
            register_prepared_connection_diagnostics(prepared, on_diagnostic)
        else:
            register_connection_diagnostics(peer_connection, data_channel, on_diagnostic)
        session: GpStationJobSession | None = None
        job_id: str | None = None
        input_sent = False
        finish_started = False
        run_started_at = time.perf_counter()
        run_started_at_ms = _now_ms()

        async def cleanup() -> None:
            if session is not None:
                if not session.closed and input_sent and not finish_started:
                    try:
                        await session.finish(timeout_seconds=timeout_seconds)
                    except Exception:
                        await session.close()
                else:
                    await session.close()
            else:
                await peer.close()
            self._active_peers.discard(peer)

        try:
            emit_diagnostic(
                peer_connection,
                data_channel,
                on_diagnostic,
                ConnectDiagnosticEvent(
                    stage="job-prewarm",
                    message="job prewarm hit" if prewarm_hit else "job prewarm miss",
                    prewarm_hit=prewarm_hit,
                    elapsed_ms=_elapsed_ms(run_started_at),
                    stage_started_at_ms=run_started_at_ms,
                ),
            )
            if attempt > 0:
                emit_diagnostic(
                    peer_connection,
                    data_channel,
                    on_diagnostic,
                    ConnectDiagnosticEvent(
                        stage="job-retry",
                        message=f"retry attempt={attempt}",
                        prewarm_hit=prewarm_hit,
                        elapsed_ms=_elapsed_ms(run_started_at),
                        stage_started_at_ms=run_started_at_ms,
                    ),
                )
            if on_status is not None:
                on_status("creating offer")
            offer_started_at = time.perf_counter()
            offer_started_at_ms = _now_ms()
            if prepared is None:
                async with asyncio.timeout(timeout_seconds):
                    offer = await peer_connection.createOffer()
                    await peer_connection.setLocalDescription(offer)
                if peer_connection.localDescription is None:
                    raise GpStationProtocolError("localDescription was not created")
                local_sdp = peer_connection.localDescription.sdp
                offer_gathering_ms = _elapsed_ms(offer_started_at)
            else:
                local_sdp = prepared.local_sdp
                offer_gathering_ms = prepared.offer_gathering_ms
            emit_diagnostic(
                peer_connection,
                data_channel,
                on_diagnostic,
                ConnectDiagnosticEvent(
                    stage="local-offer",
                    message="created local job offer",
                    elapsed_ms=_elapsed_ms(run_started_at),
                    stage_started_at_ms=offer_started_at_ms,
                    prewarm_hit=prewarm_hit,
                    offer_gathering_ms=offer_gathering_ms,
                    local_candidate_summary=summarize_sdp_candidates(local_sdp),
                    local_sdp=local_sdp,
                ),
            )
            if on_status is not None:
                on_status("creating job")
            created = _parse_job_create_result(
                await self._request(
                    self._job_api_prefix,
                    method="POST",
                    json_body={
                        "handler_type": handler_type,
                        "slave_app_id": slave_app_id,
                        "offer": {"type": "offer", "sdp": local_sdp},
                    },
                )
            )
            job_id = created.job.id
            if on_job_created is not None:
                on_job_created(created.job)
            if on_status is not None:
                on_status("waiting for answer")
            answer_started_at = time.perf_counter()
            answer_started_at_ms = _now_ms()
            answer = await self._wait_job_answer(job_id, timeout_seconds)
            if answer.answer is None or answer.answer.type != "answer" or not answer.answer.sdp:
                raise GpStationError(
                    answer.last_error or f"job {job_id} did not produce an answer (state={answer.state})"
                )
            async with asyncio.timeout(timeout_seconds):
                await peer_connection.setRemoteDescription(
                    RTCSessionDescription(type="answer", sdp=answer.answer.sdp)
                )
            emit_diagnostic(
                peer_connection,
                data_channel,
                on_diagnostic,
                ConnectDiagnosticEvent(
                    stage="remote-answer",
                    message="received remote job answer",
                    elapsed_ms=_elapsed_ms(run_started_at),
                    stage_started_at_ms=answer_started_at_ms,
                    prewarm_hit=prewarm_hit,
                    answer_wait_ms=_elapsed_ms(answer_started_at),
                    remote_candidate_summary=summarize_sdp_candidates(answer.answer.sdp),
                    remote_sdp=answer.answer.sdp,
                ),
            )
            if on_status is not None:
                on_status("waiting for data channel")
            channel_started_at = time.perf_counter()
            channel_started_at_ms = _now_ms()
            await peer.wait_until_open(timeout_seconds)
            emit_diagnostic(
                peer_connection,
                data_channel,
                on_diagnostic,
                ConnectDiagnosticEvent(
                    stage="data-channel-open",
                    message="job data channel opened",
                    elapsed_ms=_elapsed_ms(run_started_at),
                    stage_started_at_ms=channel_started_at_ms,
                    prewarm_hit=prewarm_hit,
                    data_channel_open_ms=_elapsed_ms(channel_started_at),
                ),
            )
            session = GpStationJobSession(
                job_id,
                peer,
                timeout_seconds,
                on_event,
                self._active_sessions.discard,
            )
            self._active_peers.discard(peer)
            self._active_sessions.add(session)
            peer.send_ready(job_id)
            if on_status is not None:
                on_status("waiting for result")
            input_sent = True
            first_result = await session.call(
                handler_type,
                input,
                timeout_seconds=timeout_seconds,
                on_event=on_event,
                attachments=attachments,
            )
            if not auto_finish:
                return RunJobSessionResult(
                    payload=first_result.payload,
                    files=first_result.files,
                    session=session,
                )
            if on_status is not None:
                on_status("finishing job")
            finish_started = True
            await session.finish(timeout_seconds=timeout_seconds)
            return first_result
        except asyncio.CancelledError:
            await cleanup()
            raise
        except Exception as error:
            await cleanup()
            detail = str(error)
            message = f"job {job_id} failed: {detail}" if job_id else detail
            raise _RunJobAttemptError(message, job_id, input_sent) from error

    async def _build_prepared_connection(
        self,
        slave_app_id: str,
        rtc_configuration: RTCConfiguration,
        timeout_seconds: float,
        on_diagnostic: DiagnosticCallback | None,
    ) -> PreparedJobConnection:
        prepared = await create_prepared_job_connection(
            slave_app_id,
            rtc_configuration,
            timeout_seconds,
        )
        try:
            emit_diagnostic(
                prepared.peer_connection,
                prepared.data_channel,
                on_diagnostic,
                ConnectDiagnosticEvent(
                    stage="job-prewarm",
                    message="job prewarm refreshed",
                    elapsed_ms=prepared.offer_gathering_ms,
                    stage_started_at_ms=_now_ms() - prepared.offer_gathering_ms,
                    offer_gathering_ms=prepared.offer_gathering_ms,
                    local_candidate_summary=summarize_sdp_candidates(prepared.local_sdp),
                ),
            )
            return prepared
        except Exception:
            await close_peer_connection(prepared.peer_connection, prepared.data_channel)
            raise

    async def _take_prepared_connection(
        self,
        slave_app_id: str,
        rtc_configuration: RTCConfiguration,
    ) -> PreparedJobConnection | None:
        key = job_connection_key(slave_app_id, rtc_configuration)
        stale: PreparedJobConnection | None = None
        async with self._prewarm_lock:
            prepared = self._prewarmed_connections.pop(key, None)
            if prepared is not None and not _prepared_is_usable(prepared):
                stale = prepared
                prepared = None
        if stale is not None:
            await close_peer_connection(stale.peer_connection, stale.data_channel)
        return prepared

    def _schedule_prewarm(
        self,
        slave_app_id: str,
        rtc_configuration: RTCConfiguration,
        timeout_seconds: float,
        on_diagnostic: DiagnosticCallback | None,
    ) -> None:
        async def refill() -> None:
            try:
                await self.prewarm_job_connection(
                    slave_app_id=slave_app_id,
                    rtc_configuration=rtc_configuration,
                    timeout_seconds=timeout_seconds,
                    on_diagnostic=on_diagnostic,
                )
            except asyncio.CancelledError:
                return
            except Exception as error:
                if on_diagnostic is not None:
                    try:
                        on_diagnostic(
                            ConnectDiagnosticEvent(
                                stage="job-prewarm",
                                message=f"job prewarm failed: {error}",
                            )
                        )
                    except Exception:
                        pass

        task = asyncio.create_task(refill())
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    async def _kill_job_best_effort(self, job_id: str | None) -> None:
        if job_id is None:
            return
        try:
            await self._request(
                f"{self._job_api_prefix}/{quote(job_id, safe='')}/kill",
                method="POST",
            )
        except Exception:
            pass

    async def _wait_job_answer(self, job_id: str, timeout_seconds: float) -> JobAnswerWaitResult:
        started_at = time.perf_counter()
        while True:
            elapsed = time.perf_counter() - started_at
            remaining = timeout_seconds - elapsed
            if remaining <= 0:
                raise TimeoutError(f"job answer timeout: {job_id}")
            wait_seconds = min(30.0, remaining)
            try:
                async with asyncio.timeout(remaining + 1.0):
                    payload = await self._request(
                        f"{self._job_api_prefix}/{quote(job_id, safe='')}/wait-answer"
                        f"?wait_seconds={wait_seconds:g}"
                    )
            except TimeoutError as exc:
                raise TimeoutError(f"job answer timeout: {job_id}") from exc
            result = _parse_job_answer_wait_result(payload)
            if result.answer is not None or result.state in {"failed", "cancelled", "killed", "succeeded"}:
                return result

    async def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        json_body: Any = None,
        retry_csrf: bool = True,
    ) -> Any:
        headers = {"Content-Type": "application/json"}
        if self._auth_mode == "bearer":
            headers["Authorization"] = f"Bearer {self._token}"
        csrf_required = self._uses_csrf(path, method)
        if csrf_required:
            headers["X-CSRF-Token"] = await self._ensure_csrf_token()
        response = await self._http_client.request(
            method,
            f"{self._api_base_url}{path}",
            headers=headers,
            json=json_body if json_body is not None else None,
        )
        if csrf_required and retry_csrf and response.status_code == 403:
            self._csrf_token = None
            return await self._request(
                path,
                method=method,
                json_body=json_body,
                retry_csrf=False,
            )
        if not response.is_success:
            raise GpStationHttpError(response.status_code, response.text)
        try:
            return response.json()
        except ValueError as exc:
            raise GpStationProtocolError("API response is not valid JSON") from exc

    def _uses_csrf(self, path: str, method: str) -> bool:
        return (
            self._auth_mode == "cookie"
            and path.startswith("/web/")
            and method.upper() in {"POST", "PUT", "PATCH", "DELETE"}
        )

    async def _ensure_csrf_token(self) -> str:
        if self._csrf_token is not None:
            return self._csrf_token
        async with self._csrf_lock:
            if self._csrf_token is not None:
                return self._csrf_token
            response = await self._http_client.get(
                f"{self._api_base_url}/web/auth/csrf",
                headers={"Accept": "application/json"},
            )
            if not response.is_success:
                raise GpStationHttpError(response.status_code, response.text)
            try:
                payload = response.json()
            except ValueError as exc:
                raise GpStationProtocolError("CSRF token response is not valid JSON") from exc
            token = payload.get("csrf_token") if isinstance(payload, dict) else None
            if not isinstance(token, str) or not token:
                raise GpStationProtocolError("CSRF token response is missing csrf_token")
            self._csrf_token = token
            return token

    def _ensure_open(self) -> None:
        if self._closed:
            raise GpStationError("client is closed")


def _parse_launcher(value: Any) -> LauncherView:
    payload = _require_mapping(value, "launcher")
    slave_app_ids = payload.get("slave_app_ids")
    if not isinstance(slave_app_ids, list) or not all(isinstance(item, str) for item in slave_app_ids):
        raise GpStationProtocolError("launcher slave_app_ids must be an array of strings")
    return LauncherView(
        id=_require_string(payload, "id"),
        user_id=_require_string(payload, "user_id"),
        launcher_name=_require_string(payload, "launcher_name"),
        status=_require_string(payload, "status"),
        slave_app_ids=list(slave_app_ids),
        connected_at=_require_string(payload, "connected_at"),
        last_heartbeat_at=_require_string(payload, "last_heartbeat_at"),
        ip_address=_optional_string(payload, "ip_address"),
        disconnected_at=_optional_string(payload, "disconnected_at"),
    )


def _parse_job_create_result(value: Any) -> JobCreateResult:
    payload = _require_mapping(value, "job create response")
    return JobCreateResult(
        job=_parse_job_descriptor(payload.get("job")),
        answer_wait_url=_require_string(payload, "answer_wait_url"),
    )


def _parse_job_descriptor(value: Any) -> JobDescriptor:
    payload = _require_mapping(value, "job")
    progress = payload.get("progress")
    if not isinstance(progress, list):
        raise GpStationProtocolError("job progress must be an array")
    attempt_count = payload.get("attempt_count", 0)
    if isinstance(attempt_count, bool) or not isinstance(attempt_count, int):
        raise GpStationProtocolError("job attempt_count must be an integer")
    answer = payload.get("answer")
    return JobDescriptor(
        id=_require_string(payload, "id"),
        user_id=_require_string(payload, "user_id"),
        handler_type=_require_string(payload, "handler_type"),
        slave_app_id=_require_string(payload, "slave_app_id"),
        offer=_parse_signal_payload(payload.get("offer")),
        progress=list(progress),
        state=_require_string(payload, "state"),
        answer=_parse_signal_payload(answer) if answer is not None else None,
        launcher_id=_optional_string(payload, "launcher_id"),
        assigned_at=_optional_string(payload, "assigned_at"),
        answer_ready_at=_optional_string(payload, "answer_ready_at"),
        started_at=_optional_string(payload, "started_at"),
        finished_at=_optional_string(payload, "finished_at"),
        cancel_requested_at=_optional_string(payload, "cancel_requested_at"),
        last_error=_optional_string(payload, "last_error"),
        attempt_count=attempt_count,
        created_at=_optional_string(payload, "created_at"),
        updated_at=_optional_string(payload, "updated_at"),
    )


def _parse_job_answer_wait_result(value: Any) -> JobAnswerWaitResult:
    payload = _require_mapping(value, "job answer response")
    answer = payload.get("answer")
    return JobAnswerWaitResult(
        job_id=_require_string(payload, "job_id"),
        state=_require_string(payload, "state"),
        answer=_parse_signal_payload(answer) if answer is not None else None,
        last_error=_optional_string(payload, "last_error"),
    )


def _parse_signal_payload(value: Any) -> SignalPayload:
    payload = _require_mapping(value, "signal payload")
    sdp_mline_index = payload.get("sdpMLineIndex")
    if sdp_mline_index is not None and (
        isinstance(sdp_mline_index, bool) or not isinstance(sdp_mline_index, int)
    ):
        raise GpStationProtocolError("signal payload sdpMLineIndex must be an integer")
    return SignalPayload(
        type=_require_string(payload, "type"),
        sdp=_optional_string(payload, "sdp"),
        candidate=_optional_string(payload, "candidate"),
        sdp_mid=_optional_string(payload, "sdpMid"),
        sdp_mline_index=sdp_mline_index,
    )


def _require_mapping(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise GpStationProtocolError(f"{name} must be an object")
    return value


def _require_string(value: Mapping[str, Any], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str):
        raise GpStationProtocolError(f"{key} must be a string")
    return item


def _optional_string(value: Mapping[str, Any], key: str) -> str | None:
    item = value.get(key)
    if item is not None and not isinstance(item, str):
        raise GpStationProtocolError(f"{key} must be a string")
    return item


def _normalize_api_prefix(prefix: str) -> str:
    trimmed = prefix.strip().strip("/")
    return f"/{trimmed}" if trimmed else ""


def _prepared_is_usable(prepared: PreparedJobConnection) -> bool:
    return (
        prepared.peer_connection.signalingState != "closed"
        and prepared.data_channel.readyState != "closed"
    )


def _validate_run_parameters(handler_type: str, slave_app_id: str, timeout_seconds: float) -> None:
    if not handler_type:
        raise ValueError("handler_type is required")
    if not slave_app_id:
        raise ValueError("slave_app_id is required")
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be greater than zero")


def _elapsed_ms(started_at: float) -> int:
    return round((time.perf_counter() - started_at) * 1000)


def _now_ms() -> int:
    return round(time.time() * 1000)
