from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from openai import OpenAIError
from pydantic import SecretStr

from app.llm import openai_runtime
from app.model_catalog import OpenAiLlmModelConfig


class FakeStream:
    def __init__(self, events):
        self._events = iter(events)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._events)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class FakeResponses:
    def __init__(self, *, response=None, events=None, error=None):
        self.response = response
        self.events = events
        self.error = error
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        if kwargs.get("stream"):
            return FakeStream(self.events or [])
        return self.response


class FakeAsyncOpenAI:
    def __init__(self, responses: FakeResponses, api_keys: list[str], *, api_key: str):
        self.responses = responses
        api_keys.append(api_key)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return None


def openai_model(**updates) -> OpenAiLlmModelConfig:
    values = {
        "name": "luna",
        "provider": "openai",
        "model_id": "gpt-5.6-luna",
        "context_size": 1000,
        "max_tokens": 256,
        "temperature": 0.4,
        "top_p": 0.8,
        "enable_thinking": False,
    }
    values.update(updates)
    return OpenAiLlmModelConfig.model_validate(values)


class OpenAiRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_prompt_uses_responses_json_mode_without_storage_or_tools(self) -> None:
        responses = FakeResponses(response=SimpleNamespace(output_text=' { "answer": "ok" } '))
        api_keys: list[str] = []

        with patch.object(
            openai_runtime,
            "AsyncOpenAI",
            side_effect=lambda **kwargs: FakeAsyncOpenAI(responses, api_keys, **kwargs),
        ):
            answer = await openai_runtime.ask_openai(
                openai_model(),
                SecretStr("sk-test-secret"),
                " system ",
                " prompt ",
                max_tokens=128,
                temperature=0.2,
                top_p=0.7,
                enable_thinking=False,
                response_format_json=True,
            )

        self.assertEqual(answer, '{"answer":"ok"}')
        self.assertEqual(api_keys, ["sk-test-secret"])
        request = responses.calls[0]
        self.assertEqual(request["model"], "gpt-5.6-luna")
        self.assertEqual(request["input"][0], {"role": "system", "content": "system"})
        self.assertEqual(request["max_output_tokens"], 128)
        self.assertEqual(request["temperature"], 0.2)
        self.assertEqual(request["top_p"], 0.7)
        self.assertEqual(request["reasoning"], {"effort": "none"})
        self.assertEqual(request["text"], {"format": {"type": "json_object"}})
        self.assertIs(request["store"], False)
        self.assertNotIn("tools", request)
        self.assertNotIn("previous_response_id", request)

    async def test_reasoning_effort_maps_disabled_low_and_default(self) -> None:
        model = openai_model(enable_thinking=True)
        responses = FakeResponses(response=SimpleNamespace(output_text="answer"))
        api_keys: list[str] = []

        with patch.object(
            openai_runtime,
            "AsyncOpenAI",
            side_effect=lambda **kwargs: FakeAsyncOpenAI(responses, api_keys, **kwargs),
        ):
            await openai_runtime.ask_openai(
                model,
                SecretStr("sk-test-secret"),
                "system",
                "prompt",
                enable_thinking=False,
            )
            await openai_runtime.ask_openai(
                model,
                SecretStr("sk-test-secret"),
                "system",
                "prompt",
                thinking_effort="low",
            )
            await openai_runtime.ask_openai(
                model,
                SecretStr("sk-test-secret"),
                "system",
                "prompt",
                thinking_effort="default",
            )

        self.assertEqual(
            [request["reasoning"]["effort"] for request in responses.calls],
            ["none", "low", "medium"],
        )
        self.assertEqual(responses.calls[0]["temperature"], 0.4)
        self.assertEqual(responses.calls[0]["top_p"], 0.8)
        for request in responses.calls[1:]:
            self.assertNotIn("temperature", request)
            self.assertNotIn("top_p", request)

    async def test_chat_streams_only_output_text_and_reports_usage(self) -> None:
        usage = SimpleNamespace(
            input_tokens=120,
            output_tokens=30,
            input_tokens_details=SimpleNamespace(cached_tokens=40),
        )
        completed = SimpleNamespace(usage=usage)
        responses = FakeResponses(
            events=[
                SimpleNamespace(type="response.reasoning_summary_text.delta", delta="hidden reasoning"),
                SimpleNamespace(type="response.output_text.delta", delta="first "),
                SimpleNamespace(type="response.output_text.delta", delta="second "),
                SimpleNamespace(type="response.output_text.delta", delta="third"),
                SimpleNamespace(type="response.completed", response=completed),
            ]
        )
        api_keys: list[str] = []
        deltas: list[str] = []
        on_delta = AsyncMock(side_effect=deltas.append)

        with patch.object(
            openai_runtime,
            "AsyncOpenAI",
            side_effect=lambda **kwargs: FakeAsyncOpenAI(responses, api_keys, **kwargs),
        ):
            result = await openai_runtime.generate_chat_with_openai(
                openai_model(enable_thinking=True),
                SecretStr("sk-test-secret"),
                [
                    {"role": "system", "content": "system"},
                    {"role": "user", "content": "question"},
                ],
                thinking_effort="low",
                on_delta=on_delta,
            )

        self.assertEqual(result.answer, "first second third")
        self.assertEqual("".join(deltas), "first second third")
        self.assertNotIn("hidden reasoning", result.answer)
        self.assertEqual(result.prompt_tokens, 120)
        self.assertEqual(result.max_response_tokens, 256)
        self.assertEqual(result.remaining_tokens, 850)
        self.assertIs(result.cache_enabled, True)
        self.assertIs(responses.calls[0]["stream"], True)
        self.assertEqual(responses.calls[0]["reasoning"], {"effort": "low"})
        self.assertNotIn("temperature", responses.calls[0])
        self.assertNotIn("top_p", responses.calls[0])

    async def test_chat_buffers_json_and_keeps_reference_out_of_retained_messages(self) -> None:
        completed = SimpleNamespace(
            usage=SimpleNamespace(
                input_tokens=10,
                output_tokens=5,
                input_tokens_details=SimpleNamespace(cached_tokens=0),
            )
        )
        responses = FakeResponses(
            events=[
                SimpleNamespace(type="response.output_text.delta", delta='{"answer":'),
                SimpleNamespace(type="response.output_text.delta", delta='"ok"}'),
                SimpleNamespace(type="response.completed", response=completed),
            ]
        )
        api_keys: list[str] = []
        deltas: list[str] = []
        on_delta = AsyncMock(side_effect=deltas.append)
        messages = [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "question"},
        ]

        with patch.object(
            openai_runtime,
            "AsyncOpenAI",
            side_effect=lambda **kwargs: FakeAsyncOpenAI(responses, api_keys, **kwargs),
        ):
            result = await openai_runtime.generate_chat_with_openai(
                openai_model(),
                SecretStr("sk-test-secret"),
                messages,
                response_format="json",
                on_delta=on_delta,
                reference_context="ephemeral reference",
            )

        self.assertEqual(result.answer, '{"answer":"ok"}')
        self.assertEqual(deltas, ['{"answer":"ok"}'])
        self.assertEqual(messages[-1]["content"], "question")
        self.assertEqual(responses.calls[0]["input"][-1]["content"], "ephemeral reference\n\nquestion")
        self.assertEqual(responses.calls[0]["text"], {"format": {"type": "json_object"}})
        self.assertIs(result.cache_enabled, False)

    async def test_api_errors_do_not_expose_the_api_key_or_provider_message(self) -> None:
        secret = "sk-do-not-leak"
        responses = FakeResponses(error=OpenAIError(f"request failed with {secret}"))
        api_keys: list[str] = []

        with (
            patch.object(
                openai_runtime,
                "AsyncOpenAI",
                side_effect=lambda **kwargs: FakeAsyncOpenAI(responses, api_keys, **kwargs),
            ),
            self.assertRaises(RuntimeError) as error,
        ):
            await openai_runtime.ask_openai(
                openai_model(),
                SecretStr(secret),
                "system",
                "prompt",
            )

        self.assertIn("OpenAI request failed", str(error.exception))
        self.assertNotIn(secret, str(error.exception))


if __name__ == "__main__":
    unittest.main()
