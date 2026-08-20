from __future__ import annotations

import asyncio
import os

import pytest

from ai.provider import OpenAIResponsesAdapter


@pytest.mark.live
@pytest.mark.asyncio
async def test_luna_stateless_compaction_live_smoke() -> None:
    if os.getenv("CAEMBLE_RUN_LIVE_OPENAI_SMOKE") != "1":
        pytest.skip("Set CAEMBLE_RUN_LIVE_OPENAI_SMOKE=1 to run the paid live smoke test")
    api_key = os.getenv("CAEMBLE_LIVE_OPENAI_API_KEY")
    if not api_key:
        pytest.skip("CAEMBLE_LIVE_OPENAI_API_KEY is not configured")

    adapter = OpenAIResponsesAdapter(api_key)
    deltas: list[str] = []

    async def capture(delta: str) -> None:
        deltas.append(delta)

    try:
        step = await adapter.generate(
            instructions="Reply briefly. This is an opt-in Caemble API integration smoke test.",
            input_items=[{"type": "message", "role": "user", "content": "Reply with OK."}],
            tools=[],
            reasoning_effort="low",
            reasoning_context="current_turn",
            prompt_cache_key="caemble-live-luna-smoke-v1",
            on_delta=capture,
            cancel_event=asyncio.Event(),
        )
    finally:
        await adapter.close()

    assert step.text.strip()
    assert deltas
