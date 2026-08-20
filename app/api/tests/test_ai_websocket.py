from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from pydantic import SecretStr
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import ai.router as router_module
from ai.provider import ProviderError, ProviderStep
from ai.router import _drive_run, _release_user_run, router
from caemble_catalog import Catalog
from main import app as main_app
from user_auth.routes import get_db

pytestmark = pytest.mark.slow


def start_payload():
    return {
        "type": "run.start",
        "request": {"prompt": "검토해 줘", "messages": []},
        "provider": "openai",
        "model": "gpt-5.6-luna",
        "reasoningEffort": "medium",
        "workspace": {
            "experimentId": 4,
            "document": {
                "kind": "experiment",
                "formatVersion": 2,
                "apiVersion": 7,
                "sourceBundle": {
                    "formatVersion": 5,
                    "files": {
                        "experiment.tsx": "export default () => <Main />",
                        "geometry.tsx": "export const Geometry = () => <box />",
                        "material.tsx": "export const steel = {}",
                        "simulate.py": "async def simulate(*, sim, tasks, vars):\n    return {}\n",
                        "tasks/main.tsx": "export const Main = () => <task />",
                    },
                    "geometrySnapshot": {"schemaVersion": 2, "entryImports": [], "modules": []},
                },
            },
            "baseHash": "3c60c128c781a77616d6c9ceff61eba044c5afcf2e57cbc368ac0f4f20b7c82a",
            "geometryContextVersion": "geometry-v1",
            "workspaceSession": 2,
            "activeFile": "experiment.tsx",
        },
    }


class CompletingProvider:
    async def generate(self, **request):
        await request["on_delta"]("완료")
        return ProviderStep(
            text="완료했습니다.",
            output_items=[
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "완료했습니다."}],
                }
            ],
            tool_calls=[],
        )

    async def close(self):
        pass


class WaitingProvider:
    async def generate(self, **request):
        await request["cancel_event"].wait()
        raise asyncio.CancelledError

    async def close(self):
        pass


class FailingProvider:
    async def generate(self, **_request):
        raise ProviderError(
            "OpenAI rejected the request parameters.",
            code="provider_invalid_request",
            request_id="req_safe123",
            status_code=400,
            upstream_code="unsupported_parameter",
            parameter="prompt_cache_retention",
        )

    async def close(self):
        pass


def test_main_app_registers_ai_http_and_websocket_routes():
    paths = {route.path for route in main_app.routes}
    assert {
        "/ai/providers",
        "/ai/providers/{provider}/credential",
        "/ai/providers/{provider}/credential/test",
        "/ai/agent/run",
    } <= paths


@pytest.fixture
def websocket_app(monkeypatch):
    app = FastAPI()
    catalog = Catalog.open_readonly()
    app.state.catalog = catalog
    app.include_router(router)

    class FakeDb:
        async def rollback(self):
            pass

    async def fake_db():
        yield FakeDb()

    async def fake_user(websocket, db):
        return SimpleNamespace(id="user-1", roles=["user"])

    async def fake_credential(db, user_id, provider):
        return "sk-test", 2

    app.dependency_overrides[get_db] = fake_db
    monkeypatch.setattr(router_module, "check_user", fake_user)
    monkeypatch.setattr(router_module, "get_provider_credential", fake_credential)
    monkeypatch.setattr(
        router_module.settings,
        "AI_CREDENTIAL_FERNET_KEYS",
        (SecretStr(Fernet.generate_key().decode()),),
    )
    monkeypatch.setattr(router_module.settings, "app_base_url", "https://app.example")
    monkeypatch.setattr(router_module.settings, "allowed_app_origins", ())
    yield app
    catalog.close()


def test_websocket_requires_exact_origin_and_cookie(websocket_app):
    with TestClient(websocket_app) as client:
        client.cookies.set("access_token", "cookie-token")
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                "/ai/agent/run",
                headers={"origin": "https://app.example/"},
            ):
                pass
        client.cookies.clear()
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                "/ai/agent/run",
                headers={"origin": "https://app.example"},
            ):
                pass


def test_websocket_completes_sequence_with_fake_provider(websocket_app, monkeypatch):
    monkeypatch.setattr(
        router_module,
        "create_provider_adapter",
        lambda provider, model, api_key: CompletingProvider(),
    )
    with TestClient(websocket_app) as client:
        client.cookies.set("access_token", "cookie-token")
        with client.websocket_connect(
            "/ai/agent/run",
            headers={"origin": "https://app.example"},
        ) as socket:
            socket.send_json(start_payload())
            events = []
            while not events or events[-1]["type"] != "run.completed":
                events.append(socket.receive_json())

    sequences = [event["sequence"] for event in events]
    assert sequences == list(range(1, len(events) + 1))
    assert events[0]["type"] == "run.started"
    assert all(event["stagedRevision"] == 0 for event in events)
    assert all(event["sourceHash"] == events[0]["sourceHash"] for event in events)
    assert {event["type"] for event in events} >= {
        "context.updated",
        "message.delta",
        "run.completed",
    }
    completed = events[-1]
    assert completed["baseHash"] == "3c60c128c781a77616d6c9ceff61eba044c5afcf2e57cbc368ac0f4f20b7c82a"
    assert completed["stagedRevision"] == 0
    assert completed["sessionContextEnvelope"]


def test_websocket_cancellation_reaches_running_provider(websocket_app, monkeypatch):
    monkeypatch.setattr(
        router_module,
        "create_provider_adapter",
        lambda provider, model, api_key: WaitingProvider(),
    )
    with TestClient(websocket_app) as client:
        client.cookies.set("access_token", "cookie-token")
        with client.websocket_connect(
            "/ai/agent/run",
            headers={"origin": "https://app.example"},
        ) as socket:
            socket.send_json(start_payload())
            started = socket.receive_json()
            socket.send_json({"type": "run.cancel", "runId": started["runId"]})
            cancelled = socket.receive_json()
            while cancelled["type"] != "run.cancelled":
                cancelled = socket.receive_json()

    assert cancelled["type"] == "run.cancelled"
    assert cancelled["runId"] == started["runId"]


def test_websocket_returns_structured_provider_failure(websocket_app, monkeypatch):
    monkeypatch.setattr(
        router_module,
        "create_provider_adapter",
        lambda provider, model, api_key: FailingProvider(),
    )
    with TestClient(websocket_app) as client:
        client.cookies.set("access_token", "cookie-token")
        with client.websocket_connect(
            "/ai/agent/run",
            headers={"origin": "https://app.example"},
        ) as socket:
            socket.send_json(start_payload())
            event = socket.receive_json()
            while event["type"] != "run.failed":
                event = socket.receive_json()

    assert event["message"] == "OpenAI rejected the request parameters."
    assert event["code"] == "provider_invalid_request"
    assert event["retryable"] is False
    assert event["providerRequestId"] == "req_safe123"
    assert "prompt_cache_retention" not in event


def test_websocket_overall_timeout_is_bounded(websocket_app, monkeypatch):
    monkeypatch.setattr(
        router_module,
        "create_provider_adapter",
        lambda provider, model, api_key: WaitingProvider(),
    )
    monkeypatch.setattr(router_module, "MAX_RUN_SECONDS", 0.01)
    with TestClient(websocket_app) as client:
        client.cookies.set("access_token", "cookie-token")
        with client.websocket_connect(
            "/ai/agent/run",
            headers={"origin": "https://app.example"},
        ) as socket:
            socket.send_json(start_payload())
            event = socket.receive_json()
            while event["type"] != "run.failed":
                event = socket.receive_json()

    assert event["message"] == "The AI Agent run timed out"


def test_websocket_first_message_timeout_releases_user_run(websocket_app, monkeypatch):
    monkeypatch.setattr(router_module, "FIRST_MESSAGE_SECONDS", 0.01)
    with TestClient(websocket_app) as client:
        client.cookies.set("access_token", "cookie-token")
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                "/ai/agent/run",
                headers={"origin": "https://app.example"},
            ) as socket:
                socket.receive_json()

    assert router_module._claim_user_run("user-1") is True  # noqa: SLF001
    _release_user_run("user-1")


@pytest.mark.asyncio
async def test_drive_run_rejects_removed_client_validation_messages():
    payload = json.dumps(
        {
            "type": "client_tool.result",
            "runId": "run-1",
            "callId": "stale-call",
            "stagedRevision": 0,
            "sourceHash": "a" * 64,
            "status": "unavailable",
            "result": {},
        }
    )

    class FloodingWebSocket:
        async def receive(self):
            return {"type": "websocket.receive", "text": payload}

    run_task = asyncio.create_task(asyncio.Event().wait())
    try:
        with pytest.raises(ValueError, match="Unsupported WebSocket message type"):
            await _drive_run(
                FloodingWebSocket(),
                run_task,
                asyncio.Event(),
                "run-1",
            )
    finally:
        run_task.cancel()
        await asyncio.gather(run_task, return_exceptions=True)
