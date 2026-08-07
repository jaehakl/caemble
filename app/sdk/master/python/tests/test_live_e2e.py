from __future__ import annotations

import json
import math
import os

import pytest

from gpstation_master import GpStationClient, JobEvent


API_BASE_URL_ENV = "CAEMBLE_V1_E2E_API_BASE_URL"
CLIENT_TOKEN_ENV = "CAEMBLE_V1_E2E_CLIENT_TOKEN"
TIMEOUT_SECONDS_ENV = "CAEMBLE_V1_E2E_TIMEOUT_SECONDS"
MISSING_REQUIRED_ENV = [
    name
    for name in (API_BASE_URL_ENV, CLIENT_TOKEN_ENV)
    if not os.environ.get(name, "").strip()
]


@pytest.mark.skipif(
    bool(MISSING_REQUIRED_ENV),
    reason=f"live E2E requires {', '.join(MISSING_REQUIRED_ENV)}",
)
async def test_caemble_v1_bearer_contract_live() -> None:
    timeout_value = os.environ.get(TIMEOUT_SECONDS_ENV, "300").strip()
    try:
        timeout_seconds = float(timeout_value)
    except ValueError:
        pytest.fail(f"{TIMEOUT_SECONDS_ENV} must be a positive number")
    if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
        pytest.fail(f"{TIMEOUT_SECONDS_ENV} must be a positive number")

    api_base_url = os.environ[API_BASE_URL_ENV].strip()
    token = os.environ[CLIENT_TOKEN_ENV].strip()
    events: list[JobEvent] = []

    async with GpStationClient(api_base_url, token) as client:
        launchers = await client.list_launchers()
        assert any(
            {"ai", "cae"}.issubset(launcher.slave_app_ids)
            for launcher in launchers
        ), (
            "no connected launcher advertises both ai and cae; "
            f"available={[(launcher.launcher_name, launcher.slave_app_ids) for launcher in launchers]}"
        )

        cae_result = await client.run_job(
            "cae.solvers.manifests",
            {},
            slave_app_id="cae",
            timeout_seconds=timeout_seconds,
        )
        assert isinstance(cae_result.payload, dict)
        assert cae_result.payload.get("formatVersion") == 1
        manifest_count = cae_result.payload.get("count")
        attachment_id = cae_result.payload.get("attachmentId")
        assert isinstance(manifest_count, int) and manifest_count > 0
        assert isinstance(attachment_id, str) and attachment_id
        manifest_file = next(
            (file for file in cae_result.files if file.id == attachment_id),
            None,
        )
        assert manifest_file is not None
        manifests = json.loads(manifest_file.data)
        assert isinstance(manifests, list)
        assert len(manifests) == manifest_count

        model_result = await client.run_job(
            "ai.llm.models",
            {},
            slave_app_id="ai",
            timeout_seconds=timeout_seconds,
        )
        assert isinstance(model_result.payload, dict)
        default_model = model_result.payload.get("default_model")
        models = model_result.payload.get("models")
        assert isinstance(default_model, str) and default_model
        assert isinstance(models, list) and models
        assert any(
            isinstance(model, dict) and model.get("name") == default_model
            for model in models
        )

        chat_result = await client.run_job(
            "ai.chat",
            {
                "model": default_model,
                "system_prompt": "Answer briefly and follow the user request.",
                "prompt": "Reply with the single word CAEMBLE.",
                "max_tokens": 16,
                "temperature": 0,
                "think": False,
            },
            slave_app_id="ai",
            timeout_seconds=timeout_seconds,
            auto_finish=False,
            on_event=events.append,
        )
        try:
            assert isinstance(chat_result.payload, dict)
            answer = chat_result.payload.get("answer")
            assert isinstance(answer, str) and answer
            deltas = [
                event.payload["delta"]
                for event in events
                if event.type == "ai.chat.delta"
                and isinstance(event.payload, dict)
                and isinstance(event.payload.get("delta"), str)
            ]
            assert deltas
            assert "".join(deltas) == answer
        finally:
            await chat_result.session.finish(timeout_seconds=timeout_seconds)

        assert chat_result.session.closed
