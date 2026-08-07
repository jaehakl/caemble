from __future__ import annotations

from typing import Any

import httpx
import pytest

from gpstation_master import CallResult, GpStationClient, GpStationError
from gpstation_master.client import GpStationJobSession, _RunJobAttemptError
from gpstation_master.types import JobEvent


async def install_transport(
    client: GpStationClient,
    handler: Any,
) -> None:
    await client._http_client.aclose()
    client._http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        timeout=5,
    )


def launcher_payload() -> dict[str, Any]:
    return {
        "id": "launcher-1",
        "user_id": "user-1",
        "launcher_name": "desktop",
        "status": "ready",
        "slave_app_ids": ["ai"],
        "connected_at": "2026-07-15T00:00:00Z",
        "last_heartbeat_at": "2026-07-15T00:00:01Z",
    }


async def test_bearer_list_launchers_uses_authorization_header() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=[launcher_payload()])

    client = GpStationClient("https://api.example.test/", "token-1")
    await install_transport(client, handler)
    try:
        launchers = await client.list_launchers()
    finally:
        await client.close()

    assert launchers[0].launcher_name == "desktop"
    assert requests[0].url == "https://api.example.test/v1/launchers"
    assert requests[0].headers["Authorization"] == "Bearer token-1"


async def test_cookie_request_fetches_and_refreshes_csrf_token_once() -> None:
    calls: list[tuple[str, str | None]] = []
    csrf_counter = 0
    post_counter = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal csrf_counter, post_counter
        calls.append((request.url.path, request.headers.get("X-CSRF-Token")))
        if request.url.path == "/web/auth/csrf":
            csrf_counter += 1
            return httpx.Response(200, json={"csrf_token": f"csrf-{csrf_counter}"})
        post_counter += 1
        if post_counter == 1:
            return httpx.Response(403, json={"detail": "CSRF token required"})
        return httpx.Response(200, json={"ok": True})

    client = GpStationClient(
        "https://api.example.test",
        auth_mode="cookie",
        job_api_prefix="/web/jobs",
        cookies={"session": "session-1"},
    )
    await install_transport(client, handler)
    try:
        result = await client._request("/web/jobs/job-1/kill", method="POST")
    finally:
        await client.close()

    assert result == {"ok": True}
    assert calls == [
        ("/web/auth/csrf", None),
        ("/web/jobs/job-1/kill", "csrf-1"),
        ("/web/auth/csrf", None),
        ("/web/jobs/job-1/kill", "csrf-2"),
    ]


class SessionPeer:
    def __init__(self) -> None:
        self.closed = False
        self.call_ids: list[str] = []

    async def call(
        self,
        call_id: str,
        _handler_type: str,
        _input: Any,
        _timeout_seconds: float,
        on_event: Any,
        _attachments: Any,
    ) -> CallResult[Any]:
        self.call_ids.append(call_id)
        on_event(JobEvent(id=call_id, type="ai.chat.delta", payload={"delta": "안녕"}))
        return CallResult(payload={"ok": True}, files=[])

    async def finish(self, _job_id: str, _timeout_seconds: float) -> None:
        self.closed = True

    async def close(self) -> None:
        self.closed = True


async def test_session_uses_ordered_call_ids_and_deduplicates_event_callback() -> None:
    peer = SessionPeer()
    events: list[JobEvent] = []
    callback = events.append
    session = GpStationJobSession("job-1", peer, 1, callback)  # type: ignore[arg-type]

    await session.call("ai.chat", {}, on_event=callback)
    await session.call("ai.chat", {})

    assert peer.call_ids == ["job-1", "job-1:2"]
    assert len(events) == 2


async def test_run_job_retries_once_before_input_is_sent() -> None:
    client = GpStationClient("https://api.example.test", "token-1")
    attempts: list[int] = []
    killed: list[str | None] = []

    async def run_attempt(*_: Any, attempt: int, **__: Any) -> CallResult[Any]:
        attempts.append(attempt)
        if attempt == 0:
            raise _RunJobAttemptError("offer failed", "job-1", False)
        return CallResult(payload={"ok": True}, files=[])

    async def kill(job_id: str | None) -> None:
        killed.append(job_id)

    client._run_job_attempt = run_attempt  # type: ignore[method-assign]
    client._kill_job_best_effort = kill  # type: ignore[method-assign]
    try:
        result = await client.run_job("ai.llm", {}, auto_finish=False)
    finally:
        await client.close()

    assert result.payload == {"ok": True}
    assert attempts == [0, 1]
    assert killed == ["job-1"]


async def test_run_job_does_not_retry_after_input_is_sent() -> None:
    client = GpStationClient("https://api.example.test", "token-1")
    attempts: list[int] = []

    async def run_attempt(*_: Any, attempt: int, **__: Any) -> CallResult[Any]:
        attempts.append(attempt)
        raise _RunJobAttemptError("result failed", "job-1", True)

    client._run_job_attempt = run_attempt  # type: ignore[method-assign]
    try:
        with pytest.raises(GpStationError, match="result failed"):
            await client.run_job("ai.llm", {}, auto_finish=False)
    finally:
        await client.close()

    assert attempts == [0]
