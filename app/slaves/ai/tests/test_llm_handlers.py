from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from pydantic import SecretStr
from sdk.slave import DataChannelMessage, SlaveContext

from app import __main__ as ai_slave
from app.llm import chat as llm_chat
from app.llm import handlers as llm_handlers
from app.llm import service as llm_service
from app.llm.models import (
    REFERENCE_CONTEXT_MAX_BYTES,
    ChatRequest,
    ChatResponse,
    LlmRequest,
    LlmResponse,
)
from app.model_catalog import LlmModelSelection, OpenAiLlmModelConfig


def context() -> SlaveContext:
    return SlaveContext(session_id="session-1", ttl_seconds=60)


def local_selection(name: str):
    return SimpleNamespace(model=SimpleNamespace(name=name), api_key=None)


class LlmHandlerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        ai_slave.app.memory.clear()
        model_patcher = patch.object(
            llm_chat,
            "get_selected_model_name",
            side_effect=lambda family, name: name or "default-llm",
        )
        model_patcher.start()
        self.addCleanup(model_patcher.stop)

    async def test_llm_returns_answer_payload(self) -> None:
        generate_llm_answer = AsyncMock(return_value=LlmResponse(model="default-llm", answer="hello"))

        with patch.object(llm_handlers, "generate_llm_answer", generate_llm_answer):
            response = await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-1",
                    type="ai.llm",
                    payload={
                        "system_prompt": "Answer briefly.",
                        "prompt": "Say hello.",
                        "context_size": 8192,
                        "top_p": 0.75,
                        "think": True,
                    },
                ),
                context(),
            )

        self.assertEqual(response.type, "ai.llm.result")
        self.assertEqual(response.payload, {"model": "default-llm", "answer": "hello"})
        self.assertEqual(response.attachments, [])
        generate_llm_answer.assert_awaited_once()
        request = generate_llm_answer.await_args.args[0]
        self.assertEqual(request.context_size, 8192)
        self.assertEqual(request.top_p, 0.75)
        self.assertIs(request.think, True)

    def test_llm_request_accepts_korean_text(self) -> None:
        request = LlmRequest(system_prompt="친절하게 답하세요.", prompt="한글 질문입니다.")

        self.assertEqual(request.prompt, "한글 질문입니다.")

    def test_llm_request_accepts_think_and_defaults_to_model_setting(self) -> None:
        self.assertIs(LlmRequest(system_prompt="system", prompt="prompt", think=True).think, True)
        self.assertIs(LlmRequest(system_prompt="system", prompt="prompt", think=False).think, False)
        self.assertIsNone(LlmRequest(system_prompt="system", prompt="prompt").think)
        defaults = LlmRequest(system_prompt="system", prompt="prompt")
        self.assertEqual(defaults.thinking_effort, "default")
        self.assertEqual(defaults.response_format, "text")

    def test_llm_request_rejects_surrogate_text(self) -> None:
        with self.assertRaises(ValueError) as error:
            LlmRequest(system_prompt="system", prompt="bad\udcec")

        self.assertIn("invalid Unicode surrogate", str(error.exception))

    async def test_chat_streams_and_returns_answer_payload(self) -> None:
        events = []

        async def send_event(event_type, payload):
            events.append((event_type, payload))

        async def generate_chat_answer(request, messages, on_delta):
            self.assertEqual(request.context_size, 16384)
            self.assertEqual(request.top_p, 0.8)
            self.assertEqual(
                messages,
                [
                    {"role": "system", "content": "Answer briefly."},
                    {"role": "user", "content": "Say hello."},
                ],
            )
            await on_delta("he")
            await on_delta("llo")
            return ChatResponse(
                model=request.model,
                answer="hello",
                context_window=4096,
                prompt_tokens=12,
                max_response_tokens=512,
                remaining_tokens=4078,
                cache_enabled=True,
            )

        with patch.object(llm_handlers, "generate_chat_answer", generate_chat_answer):
            response = await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-1",
                    type="ai.chat",
                    payload={
                        "system_prompt": "Answer briefly.",
                        "prompt": "Say hello.",
                        "context_size": 16384,
                        "top_p": 0.8,
                    },
                ),
                SlaveContext(
                    session_id="session-1",
                    ttl_seconds=60,
                    call_id="call-1",
                    _event_sender=send_event,
                ),
            )

        self.assertEqual(
            response.payload,
            {
                "model": "default-llm",
                "answer": "hello",
                "context_window": 4096,
                "prompt_tokens": 12,
                "max_response_tokens": 512,
                "remaining_tokens": 4078,
                "cache_enabled": True,
            },
        )
        self.assertEqual(events, [("ai.chat.delta", {"delta": "he"}), ("ai.chat.delta", {"delta": "llo"})])
        self.assertEqual(
            ai_slave.app.memory[llm_chat.CHAT_MEMORY_KEY]["messages"],
            [
                {"role": "system", "content": "Answer briefly."},
                {"role": "user", "content": "Say hello."},
                {"role": "assistant", "content": "hello"},
            ],
        )

    async def test_chat_reuses_context_for_prompt_only_followup(self) -> None:
        calls = []

        async def generate_chat_answer(request, messages, on_delta):
            calls.append(messages)
            return ChatResponse(
                model=request.model,
                answer=f"answer {len(calls)}",
                context_window=4096,
                prompt_tokens=10 + len(calls),
                max_response_tokens=512,
                remaining_tokens=4000 - len(calls),
                cache_enabled=True,
            )

        with patch.object(llm_handlers, "generate_chat_answer", generate_chat_answer):
            first = await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-1",
                    type="ai.chat",
                    payload={"system_prompt": "Stay concise.", "prompt": "First question."},
                ),
                context(),
            )
            second = await ai_slave.app.dispatch(
                DataChannelMessage(id="call-2", type="ai.chat", payload={"prompt": "Second question."}),
                context(),
            )

        self.assertEqual(first.payload["answer"], "answer 1")
        self.assertEqual(second.payload["answer"], "answer 2")
        self.assertEqual(
            calls[1],
            [
                {"role": "system", "content": "Stay concise."},
                {"role": "user", "content": "First question."},
                {"role": "assistant", "content": "answer 1"},
                {"role": "user", "content": "Second question."},
            ],
        )

    async def test_chat_reference_context_is_generation_only_and_not_accumulated(self) -> None:
        calls = []

        async def generate_chat_answer(request, messages, on_delta):
            generation_messages = llm_chat.build_reference_generation_messages(
                messages,
                request.reference_context,
            )
            calls.append(generation_messages)
            return ChatResponse(
                model=request.model,
                answer=f"answer {len(calls)}",
                context_window=4096,
                prompt_tokens=10,
                max_response_tokens=512,
                remaining_tokens=4000,
                cache_enabled=True,
            )

        with patch.object(llm_handlers, "generate_chat_answer", generate_chat_answer):
            await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-1",
                    type="ai.chat",
                    payload={
                        "system_prompt": "Use the provided documentation.",
                        "prompt": "첫 번째 질문",
                        "reference_context": "첫 참고자료: structure() 사용법",
                    },
                ),
                context(),
            )
            await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-2",
                    type="ai.chat",
                    payload={
                        "prompt": "두 번째 질문",
                        "reference_context": "둘째 참고자료: experiment() 사용법",
                    },
                ),
                context(),
            )
            await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-3",
                    type="ai.chat",
                    payload={"prompt": "참고자료 없는 질문"},
                ),
                context(),
            )

        first_generation = calls[0][-1]["content"]
        self.assertIn("첫 참고자료: structure() 사용법", first_generation)
        self.assertTrue(first_generation.endswith("\n\n첫 번째 질문"))

        second_generation_text = "\n".join(message["content"] for message in calls[1])
        self.assertNotIn("첫 참고자료: structure() 사용법", second_generation_text)
        self.assertIn("둘째 참고자료: experiment() 사용법", second_generation_text)
        self.assertIn("첫 번째 질문", second_generation_text)

        third_generation_text = "\n".join(message["content"] for message in calls[2])
        self.assertNotIn("첫 참고자료: structure() 사용법", third_generation_text)
        self.assertNotIn("둘째 참고자료: experiment() 사용법", third_generation_text)
        self.assertEqual(calls[2][-1], {"role": "user", "content": "참고자료 없는 질문"})

        self.assertEqual(
            ai_slave.app.memory[llm_chat.CHAT_MEMORY_KEY]["messages"],
            [
                {"role": "system", "content": "Use the provided documentation."},
                {"role": "user", "content": "첫 번째 질문"},
                {"role": "assistant", "content": "answer 1"},
                {"role": "user", "content": "두 번째 질문"},
                {"role": "assistant", "content": "answer 2"},
                {"role": "user", "content": "참고자료 없는 질문"},
                {"role": "assistant", "content": "answer 3"},
            ],
        )

    async def test_chat_requires_system_prompt_for_first_call(self) -> None:
        with self.assertRaises(ValueError) as error:
            await ai_slave.app.dispatch(
                DataChannelMessage(id="call-1", type="ai.chat", payload={"prompt": "Hello."}),
                context(),
            )

        self.assertEqual(str(error.exception), "system_prompt is required for the first ai.chat call")

    async def test_chat_rejects_system_prompt_change_in_active_session(self) -> None:
        async def generate_chat_answer(request, messages, on_delta):
            return ChatResponse(
                model=request.model,
                answer="ok",
                context_window=4096,
                prompt_tokens=8,
                max_response_tokens=512,
                remaining_tokens=4080,
                cache_enabled=True,
            )

        with patch.object(llm_handlers, "generate_chat_answer", generate_chat_answer):
            await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-1",
                    type="ai.chat",
                    payload={"system_prompt": "Original system.", "prompt": "Hello."},
                ),
                context(),
            )
            with self.assertRaises(ValueError) as error:
                await ai_slave.app.dispatch(
                    DataChannelMessage(
                        id="call-2",
                        type="ai.chat",
                        payload={"system_prompt": "Changed system.", "prompt": "Hello again."},
                    ),
                    context(),
                )

        self.assertEqual(str(error.exception), "system_prompt cannot change within an active ai.chat session")

    async def test_chat_allows_enable_thinking_change_in_active_session(self) -> None:
        requests = []

        async def generate_chat_answer(request, messages, on_delta):
            requests.append(request)
            return ChatResponse(
                model=request.model,
                answer=f"answer {len(requests)}",
                context_window=4096,
                prompt_tokens=10,
                max_response_tokens=512,
                remaining_tokens=4000,
                cache_enabled=True,
            )

        with patch.object(llm_handlers, "generate_chat_answer", generate_chat_answer):
            await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-1",
                    type="ai.chat",
                    payload={
                        "system_prompt": "Stay concise.",
                        "prompt": "First question.",
                        "enable_thinking": False,
                    },
                ),
                context(),
            )
            await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-2",
                    type="ai.chat",
                    payload={"prompt": "Second question.", "enable_thinking": True},
                ),
                context(),
            )

        self.assertIs(requests[0].think, False)
        self.assertIs(requests[1].think, True)

    def test_chat_request_accepts_korean_text(self) -> None:
        request = ChatRequest(
            system_prompt="친절하게 답하세요.",
            prompt="한글 질문입니다.",
            reference_context="한글 참고자료입니다.",
        )

        self.assertEqual(request.prompt, "한글 질문입니다.")
        self.assertEqual(request.reference_context, "한글 참고자료입니다.")

    def test_chat_request_limits_reference_context_by_utf8_bytes(self) -> None:
        maximum = "x" * REFERENCE_CONTEXT_MAX_BYTES
        self.assertEqual(
            ChatRequest(system_prompt="system", prompt="prompt", reference_context=maximum).reference_context,
            maximum,
        )

        with self.assertRaises(ValueError) as error:
            ChatRequest(
                system_prompt="system",
                prompt="prompt",
                reference_context="한" * ((REFERENCE_CONTEXT_MAX_BYTES // 3) + 1),
            )

        self.assertIn(f"exceeds {REFERENCE_CONTEXT_MAX_BYTES} UTF-8 bytes", str(error.exception))

    def test_chat_request_accepts_enable_thinking(self) -> None:
        request = ChatRequest(system_prompt="system", prompt="prompt", enable_thinking=True)

        self.assertIs(request.think, True)

    def test_chat_request_rejects_conflicting_thinking_fields(self) -> None:
        with self.assertRaisesRegex(ValueError, "must match"):
            ChatRequest(
                system_prompt="system",
                prompt="prompt",
                think=True,
                enable_thinking=False,
            )

    def test_chat_request_rejects_surrogate_text(self) -> None:
        with self.assertRaises(ValueError) as error:
            ChatRequest(system_prompt="system", prompt="prompt", reference_context="bad\udcec")

        self.assertIn("invalid Unicode surrogate", str(error.exception))

    def test_reference_generation_prunes_oldest_history_by_token_budget(self) -> None:
        class CharacterTokenizer:
            @staticmethod
            def tokenize(value, add_bos=False, special=True):
                return list(value.decode("utf-8"))

        base_messages = [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "old question " * 5},
            {"role": "assistant", "content": "old answer " * 5},
            {"role": "user", "content": "recent question"},
            {"role": "assistant", "content": "recent answer"},
            {"role": "user", "content": "current question"},
        ]
        generation_messages = llm_chat.build_reference_generation_messages(
            base_messages,
            "reference data",
        )
        recent_only = [generation_messages[0], *generation_messages[3:]]
        recent_tokens = llm_chat._estimate_prompt_tokens(CharacterTokenizer(), recent_only)

        selected = llm_chat._select_reference_generation_messages(
            CharacterTokenizer(),
            generation_messages,
            context_size=recent_tokens + 32,
            max_response_tokens=32,
        )

        self.assertEqual(selected, recent_only)
        self.assertNotIn("old question", "\n".join(message["content"] for message in selected))

    def test_reference_generation_rejects_reference_and_question_over_context(self) -> None:
        class CharacterTokenizer:
            @staticmethod
            def tokenize(value, add_bos=False, special=True):
                return list(value.decode("utf-8"))

        generation_messages = llm_chat.build_reference_generation_messages(
            [
                {"role": "system", "content": "system"},
                {"role": "user", "content": "question"},
            ],
            "large reference",
        )
        minimum_tokens = llm_chat._estimate_prompt_tokens(CharacterTokenizer(), generation_messages)

        with self.assertRaisesRegex(ValueError, "exceed the LLM context window"):
            llm_chat._select_reference_generation_messages(
                CharacterTokenizer(),
                generation_messages,
                context_size=minimum_tokens,
                max_response_tokens=1,
            )

    async def test_chat_switches_models_and_keeps_history(self) -> None:
        calls = []

        async def generate_chat_answer(request, messages, on_delta):
            calls.append((request.model, messages))
            return ChatResponse(
                model=request.model,
                answer="ok",
                context_window=4096,
                prompt_tokens=8,
                max_response_tokens=512,
                remaining_tokens=4080,
                cache_enabled=True,
            )

        with patch.object(llm_handlers, "generate_chat_answer", generate_chat_answer):
            await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-1",
                    type="ai.chat",
                    payload={"model": "first", "system_prompt": "system", "prompt": "one"},
                ),
                context(),
            )
            await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-2",
                    type="ai.chat",
                    payload={"model": "second", "prompt": "two"},
                ),
                context(),
            )
            third = await ai_slave.app.dispatch(
                DataChannelMessage(id="call-3", type="ai.chat", payload={"prompt": "three"}),
                context(),
            )

        self.assertEqual([call[0] for call in calls], ["first", "second", "second"])
        self.assertEqual(calls[1][1][2], {"role": "assistant", "content": "ok"})
        self.assertEqual(third.payload["model"], "second")


class LlmServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_llm_forwards_context_size_and_top_p(self) -> None:
        ask_llm = AsyncMock(return_value="answer")
        request = LlmRequest(
            model="model-a",
            system_prompt="system",
            prompt="prompt",
            context_size=12288,
            top_p=0.65,
            think=True,
        )
        with (
            patch.object(llm_service, "resolve_llm_selection", return_value=local_selection("model-a")),
            patch.object(llm_service, "ask_llm", ask_llm),
        ):
            response = await llm_service.generate_llm_answer(request)

        self.assertEqual(response.model, "model-a")
        self.assertEqual(ask_llm.await_args.kwargs["context_size"], 12288)
        self.assertEqual(ask_llm.await_args.kwargs["top_p"], 0.65)
        self.assertIs(ask_llm.await_args.kwargs["enable_thinking"], True)
        self.assertIs(ask_llm.await_args.kwargs["response_format_json"], False)

    async def test_llm_adds_low_thinking_instruction_and_forwards_json_format(self) -> None:
        ask_llm = AsyncMock(return_value='{"answer":"ok"}')
        request = LlmRequest(
            system_prompt="system",
            prompt="prompt",
            think=True,
            thinking_effort="low",
            response_format="json",
        )
        with (
            patch.object(llm_service, "resolve_llm_selection", return_value=local_selection("model-a")),
            patch.object(llm_service, "ask_llm", ask_llm),
        ):
            await llm_service.generate_llm_answer(request)

        self.assertEqual(ask_llm.await_args.args[0], "system")
        self.assertEqual(ask_llm.await_args.kwargs["thinking_effort"], "low")
        self.assertIs(ask_llm.await_args.kwargs["response_format_json"], True)

    async def test_llm_does_not_add_low_instruction_when_thinking_is_disabled(self) -> None:
        ask_llm = AsyncMock(return_value="answer")
        request = LlmRequest(
            system_prompt="system",
            prompt="prompt",
            think=False,
            thinking_effort="low",
        )
        with (
            patch.object(llm_service, "resolve_llm_selection", return_value=local_selection("model-a")),
            patch.object(llm_service, "ask_llm", ask_llm),
        ):
            await llm_service.generate_llm_answer(request)

        self.assertEqual(ask_llm.await_args.args[0], "system")

    async def test_chat_forwards_context_size_and_top_p(self) -> None:
        generate_chat = AsyncMock(
            return_value=SimpleNamespace(
                answer="answer",
                context_window=24576,
                prompt_tokens=10,
                max_response_tokens=20,
                remaining_tokens=24546,
                cache_enabled=True,
            )
        )
        request = ChatRequest(
            model="model-b",
            prompt="prompt",
            reference_context="Product documentation",
            context_size=24576,
            top_p=0.55,
        )
        with (
            patch.object(llm_service, "resolve_llm_selection", return_value=local_selection("model-b")),
            patch.object(llm_service, "generate_chat_with_llm", generate_chat),
        ):
            response = await llm_service.generate_chat_answer(request, [], AsyncMock())

        self.assertEqual(response.context_window, 24576)
        self.assertEqual(generate_chat.await_args.kwargs["context_size"], 24576)
        self.assertEqual(generate_chat.await_args.kwargs["top_p"], 0.55)
        self.assertEqual(generate_chat.await_args.kwargs["reference_context"], "Product documentation")

    async def test_llm_dispatches_openai_without_calling_local_runtime(self) -> None:
        model = OpenAiLlmModelConfig(
            name="luna",
            provider="openai",
            model_id="gpt-5.6-luna",
            context_size=1050000,
            max_tokens=8192,
            temperature=0.4,
            top_p=0.9,
            enable_thinking=False,
        )
        selection = LlmModelSelection(model=model, api_key=SecretStr("sk-test"))
        ask_openai = AsyncMock(return_value="openai answer")
        ask_llm = AsyncMock()

        with (
            patch.object(llm_service, "resolve_llm_selection", return_value=selection),
            patch.object(llm_service, "ask_openai", ask_openai),
            patch.object(llm_service, "ask_llm", ask_llm),
        ):
            response = await llm_service.generate_llm_answer(
                LlmRequest(system_prompt="system", prompt="prompt", think=True, thinking_effort="low")
            )

        self.assertEqual(response, LlmResponse(model="luna", answer="openai answer"))
        ask_openai.assert_awaited_once()
        self.assertEqual(ask_openai.await_args.args[:2], (model, selection.api_key))
        self.assertEqual(ask_openai.await_args.kwargs["thinking_effort"], "low")
        ask_llm.assert_not_awaited()

    async def test_chat_dispatches_openai_without_calling_local_runtime(self) -> None:
        model = OpenAiLlmModelConfig(
            name="luna",
            provider="openai",
            model_id="gpt-5.6-luna",
            context_size=1050000,
            max_tokens=8192,
            temperature=0.4,
            top_p=0.9,
            enable_thinking=False,
        )
        selection = LlmModelSelection(model=model, api_key=SecretStr("sk-test"))
        openai_chat = AsyncMock(
            return_value=SimpleNamespace(
                answer="openai answer",
                context_window=1050000,
                prompt_tokens=20,
                max_response_tokens=8192,
                remaining_tokens=1049970,
                cache_enabled=False,
            )
        )
        local_chat = AsyncMock()

        with (
            patch.object(llm_service, "resolve_llm_selection", return_value=selection),
            patch.object(llm_service, "generate_chat_with_openai", openai_chat),
            patch.object(llm_service, "generate_chat_with_llm", local_chat),
        ):
            response = await llm_service.generate_chat_answer(
                ChatRequest(prompt="prompt", reference_context="reference"),
                [{"role": "user", "content": "prompt"}],
                AsyncMock(),
            )

        self.assertEqual(response.model, "luna")
        self.assertEqual(openai_chat.await_args.kwargs["reference_context"], "reference")
        local_chat.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
