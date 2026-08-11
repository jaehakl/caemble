from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from app.llm import chat as llm_chat
from app.llm import generation as llm_generation
from app.llm import runtime as llm_runtime
from app.model_catalog import LlmModelConfig


class NullAsyncContext:
    async def __aenter__(self):
        return None

    async def __aexit__(self, exc_type, exc, traceback):
        return None


class FakeStreamingLlm:
    def __init__(self, chunks):
        self.chunks = chunks
        self.kwargs = None
        self.n_tokens = 24
        self.cache = None
        self.set_cache_calls = 0
        self.enable_thinking_override = None

    def create_chat_completion(self, **kwargs):
        self.kwargs = kwargs
        self.enable_thinking_override = getattr(self, "_ai_slave_enable_thinking_override", None)
        return iter(self.chunks)

    def set_cache(self, cache):
        self.cache = cache
        self.set_cache_calls += 1

    def tokenize(self, text, add_bos=False, special=False):
        return list(range(max(1, len(text) // 3)))


class FakeCache:
    pass


class FakePromptCompletionLlm:
    def __init__(self, content: str = "answer", error: Exception | None = None):
        self.content = content
        self.error = error
        self.enable_thinking_override = None
        self.kwargs = None

    def create_chat_completion(self, **kwargs):
        self.kwargs = kwargs
        self.enable_thinking_override = getattr(self, "_ai_slave_enable_thinking_override", None)
        if self.error is not None:
            raise self.error
        return {"choices": [{"message": {"content": self.content}}]}


def config() -> llm_runtime.PromptLlmConfig:
    return llm_runtime.PromptLlmConfig(
        name="test-llm",
        model_path="fake.gguf",
        context_size=4096,
        n_gpu_layers=0,
        n_threads=None,
        main_gpu=None,
        split_mode=None,
        tensor_split=None,
        lease_device_ids=(),
        flash_attn=True,
        swa_full=False,
        n_batch=512,
        n_ubatch=512,
        offload_kqv=True,
        enable_thinking=False,
        model_key=("fake.gguf", 4096, 0, None, None, None, None, (), True, False, 512, 512, True, False),
        max_tokens=32,
        temperature=0.25,
        top_p=0.9,
    )


def model_config(**updates) -> LlmModelConfig:
    values = {
        "name": "test-llm",
        "path": "fake.gguf",
        "use_max_gpu": False,
        "context_size": 4096,
        "split_mode": "layer",
        "tensor_split": [],
        "main_gpu": 0,
        "flash_attn": True,
        "swa_full": False,
        "n_batch": 512,
        "n_ubatch": 512,
        "offload_kqv": True,
        "max_tokens": 1024,
        "temperature": 0.5,
        "top_p": 0.9,
        "enable_thinking": False,
    }
    values.update(updates)
    return LlmModelConfig.model_validate(values)


class FakePromptLlm:
    kwargs = None

    def __init__(self, **kwargs):
        self.__class__.kwargs = kwargs

    def close(self):
        return None


class FakeFailingPromptLlm:
    def __init__(self, **kwargs):
        raise ValueError("Failed to create llama_context")


class LlmChatRuntimeTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        model_patcher = patch.object(
            llm_chat,
            "get_selected_model_name",
            side_effect=lambda family, name: name or "test-llm",
        )
        model_patcher.start()
        self.addCleanup(model_patcher.stop)

    def test_build_prompt_llm_config_uses_toml_context_size(self) -> None:
        model = model_config(context_size=6144)
        with patch.object(llm_runtime, "resolve_llm_model", return_value=(model, "fake.gguf")):
            config = llm_runtime.build_prompt_llm_config()

        self.assertEqual(config.context_size, 6144)
        self.assertEqual(config.model_key[1], 6144)
        self.assertEqual(config.name, "test-llm")

    def test_build_prompt_llm_config_uses_model_defaults_and_request_overrides(self) -> None:
        model = model_config(
            context_size=8192,
            max_tokens=2048,
            temperature=0.8,
            top_p=0.7,
        )
        with patch.object(llm_runtime, "resolve_llm_model", return_value=(model, "fake.gguf")):
            default_config = llm_runtime.build_prompt_llm_config()
            overridden_config = llm_runtime.build_prompt_llm_config(
                max_tokens=-64,
                temperature=20.0,
                context_size=16384,
                top_p=0.2,
            )
            top_p_only_config = llm_runtime.build_prompt_llm_config(top_p=0.1)

        self.assertEqual(default_config.context_size, 8192)
        self.assertEqual(default_config.max_tokens, 2048)
        self.assertEqual(default_config.temperature, 0.8)
        self.assertEqual(default_config.top_p, 0.7)
        self.assertEqual(overridden_config.max_tokens, -64)
        self.assertEqual(overridden_config.temperature, 20.0)
        self.assertEqual(overridden_config.context_size, 16384)
        self.assertEqual(overridden_config.top_p, 0.2)
        self.assertNotEqual(default_config.model_key, overridden_config.model_key)
        self.assertEqual(default_config.model_key, top_p_only_config.model_key)

    def test_build_prompt_llm_config_uses_context_memory_settings(self) -> None:
        model = model_config(
            flash_attn=False,
            swa_full=True,
            n_batch=256,
            n_ubatch=128,
            offload_kqv=False,
        )
        with patch.object(llm_runtime, "resolve_llm_model", return_value=(model, "fake.gguf")):
            config = llm_runtime.build_prompt_llm_config()

        self.assertIs(config.flash_attn, False)
        self.assertIs(config.swa_full, True)
        self.assertEqual(config.n_batch, 256)
        self.assertEqual(config.n_ubatch, 128)
        self.assertIs(config.offload_kqv, False)
        self.assertEqual(config.model_key[8:], (False, True, 256, 128, False, False))

    def test_build_prompt_llm_config_uses_enable_thinking_setting_in_model_key(self) -> None:
        disabled = model_config()
        enabled = disabled.model_copy(update={"enable_thinking": True})
        with patch.object(llm_runtime, "resolve_llm_model", return_value=(disabled, "fake.gguf")):
            disabled_config = llm_runtime.build_prompt_llm_config()
        with patch.object(llm_runtime, "resolve_llm_model", return_value=(enabled, "fake.gguf")):
            enabled_config = llm_runtime.build_prompt_llm_config()

        self.assertIs(disabled_config.enable_thinking, False)
        self.assertIs(enabled_config.enable_thinking, True)
        self.assertNotEqual(disabled_config.model_key, enabled_config.model_key)

    def test_model_config_accepts_values_without_numeric_range_validation(self) -> None:
        model = model_config(
            context_size=-1,
            tensor_split=[1, -1],
            main_gpu=-2,
            n_batch=0,
            n_ubatch=-3,
            max_tokens=-4,
            temperature=9.0,
            top_p=2.0,
        )

        self.assertEqual(model.context_size, -1)
        self.assertEqual(model.tensor_split, [1.0, -1.0])
        self.assertEqual(model.n_batch, 0)
        self.assertEqual(model.max_tokens, -4)

    def test_build_prompt_llm_config_uses_multi_gpu_split_settings(self) -> None:
        model = model_config(
            use_max_gpu=True,
            context_size=8192,
            split_mode="layer",
            tensor_split=[1, 1],
        )
        with (
            patch.object(llm_runtime, "resolve_llm_model", return_value=(model, "fake.gguf")),
            patch.object(llm_runtime, "get_cuda_device_count", return_value=2),
        ):
            config = llm_runtime.build_prompt_llm_config()

        self.assertEqual(config.split_mode, llm_runtime.LLM_SPLIT_MODE_LAYER)
        self.assertEqual(config.tensor_split, (1.0, 1.0))
        self.assertEqual(config.lease_device_ids, (0, 1))
        self.assertEqual(config.model_key[6], (1.0, 1.0))
        self.assertEqual(config.model_key[7], (0, 1))

    def test_build_prompt_llm_config_supports_tensor_split_mode(self) -> None:
        model = model_config(
            use_max_gpu=True,
            split_mode="tensor",
            tensor_split=[1, 1],
        )
        with (
            patch.object(llm_runtime, "resolve_llm_model", return_value=(model, "fake.gguf")),
            patch.object(llm_runtime, "get_cuda_device_count", return_value=2),
        ):
            config = llm_runtime.build_prompt_llm_config()

        self.assertEqual(config.split_mode, llm_runtime.LLM_SPLIT_MODE_TENSOR)
        self.assertEqual(config.tensor_split, (1.0, 1.0))
        self.assertEqual(config.lease_device_ids, (0, 1))

    def test_model_config_rejects_invalid_split_mode_only(self) -> None:
        with self.assertRaises(ValueError):
            model_config(split_mode="bad")

    def test_optional_thread_and_gpu_layer_values_override_fallbacks(self) -> None:
        explicit = model_config(use_max_gpu=True, n_threads=6, n_gpu_layers=12)
        fallback_gpu = model_config(use_max_gpu=True)
        fallback_cpu = model_config(use_max_gpu=False)
        with (
            patch.object(llm_runtime, "get_cuda_device_count", return_value=1),
            patch.object(llm_runtime, "resolve_llm_model", return_value=(explicit, "fake.gguf")),
        ):
            explicit_config = llm_runtime.build_prompt_llm_config()
        with (
            patch.object(llm_runtime, "get_cuda_device_count", return_value=1),
            patch.object(llm_runtime, "resolve_llm_model", return_value=(fallback_gpu, "fake.gguf")),
        ):
            gpu_config = llm_runtime.build_prompt_llm_config()
        with patch.object(llm_runtime, "resolve_llm_model", return_value=(fallback_cpu, "fake.gguf")):
            cpu_config = llm_runtime.build_prompt_llm_config()

        self.assertEqual((explicit_config.n_threads, explicit_config.n_gpu_layers), (6, 12))
        self.assertEqual(gpu_config.n_gpu_layers, -1)
        self.assertIsNone(gpu_config.n_threads)
        self.assertEqual(cpu_config.n_gpu_layers, 0)
        self.assertNotEqual(explicit_config.model_key, gpu_config.model_key)

    def test_get_prompt_llm_passes_multi_gpu_kwargs(self) -> None:
        config = llm_runtime.PromptLlmConfig(
            name="test-llm",
            model_path="fake.gguf",
            context_size=4096,
            n_gpu_layers=-1,
            n_threads=6,
            main_gpu=0,
            split_mode=llm_runtime.LLM_SPLIT_MODE_LAYER,
            tensor_split=(1.0, 1.0),
            lease_device_ids=(0, 1),
            flash_attn=True,
            swa_full=False,
            n_batch=512,
            n_ubatch=256,
            offload_kqv=True,
            enable_thinking=False,
            model_key=(
                "fake.gguf",
                4096,
                -1,
                6,
                0,
                llm_runtime.LLM_SPLIT_MODE_LAYER,
                (1.0, 1.0),
                (0, 1),
                True,
                False,
                512,
                256,
                True,
                False,
            ),
            max_tokens=32,
            temperature=0.25,
            top_p=0.9,
        )

        try:
            with patch.object(llm_runtime, "_load_llama_cls", return_value=FakePromptLlm):
                llm_runtime._get_prompt_llm_locked(config)

            self.assertEqual(FakePromptLlm.kwargs["n_ctx"], 4096)
            self.assertEqual(FakePromptLlm.kwargs["n_gpu_layers"], -1)
            self.assertEqual(FakePromptLlm.kwargs["n_threads"], 6)
            self.assertEqual(FakePromptLlm.kwargs["main_gpu"], 0)
            self.assertEqual(FakePromptLlm.kwargs["split_mode"], llm_runtime.LLM_SPLIT_MODE_LAYER)
            self.assertEqual(FakePromptLlm.kwargs["tensor_split"], [1.0, 1.0])
            self.assertIs(FakePromptLlm.kwargs["flash_attn"], True)
            self.assertIs(FakePromptLlm.kwargs["swa_full"], False)
            self.assertEqual(FakePromptLlm.kwargs["n_batch"], 512)
            self.assertEqual(FakePromptLlm.kwargs["n_ubatch"], 256)
            self.assertIs(FakePromptLlm.kwargs["offload_kqv"], True)
            self.assertTrue(callable(FakePromptLlm.kwargs["chat_handler"]))
        finally:
            llm_runtime.release_llm_runtime()

    def test_get_prompt_llm_omits_unspecified_thread_count(self) -> None:
        try:
            with patch.object(llm_runtime, "_load_llama_cls", return_value=FakePromptLlm):
                llm_runtime._get_prompt_llm_locked(config())

            self.assertNotIn("n_threads", FakePromptLlm.kwargs)
        finally:
            llm_runtime.release_llm_runtime()

    def test_llm_chat_handler_injects_enable_thinking_into_metadata_template(self) -> None:
        calls = []

        def base_handler(**kwargs):
            calls.append(kwargs)
            return {"ok": True}

        class FakeLlama:
            _chat_handlers = {"chat_template.default": base_handler}
            chat_format = "qwen"

        handler = llm_runtime._create_llm_chat_handler(False)

        result = handler(llama=FakeLlama(), messages=[{"role": "user", "content": "hello"}], stream=True)

        self.assertEqual(result, {"ok": True})
        self.assertIs(calls[0]["enable_thinking"], False)
        self.assertEqual(calls[0]["messages"], [{"role": "user", "content": "hello"}])
        self.assertIs(calls[0]["stream"], True)

    def test_llm_chat_handler_respects_enable_thinking_true(self) -> None:
        calls = []

        def base_handler(**kwargs):
            calls.append(kwargs)
            return {"ok": True}

        class FakeLlama:
            _chat_handlers = {"chat_template.default": base_handler}
            chat_format = "qwen"

        llm_runtime._create_llm_chat_handler(True)(llama=FakeLlama(), messages=[])

        self.assertIs(calls[0]["enable_thinking"], True)

    def test_llm_chat_handler_uses_request_enable_thinking_override(self) -> None:
        calls = []

        def base_handler(**kwargs):
            calls.append(kwargs)
            return {"ok": True}

        class FakeLlama:
            _chat_handlers = {"chat_template.default": base_handler}
            chat_format = "qwen"
            _ai_slave_enable_thinking_override = False

        llm_runtime._create_llm_chat_handler(True)(llama=FakeLlama(), messages=[])

        self.assertIs(calls[0]["enable_thinking"], False)

    def test_get_prompt_llm_wraps_llama_context_creation_failure(self) -> None:
        try:
            with (
                patch.object(llm_runtime, "_load_llama_cls", return_value=FakeFailingPromptLlm),
                self.assertRaises(RuntimeError) as error,
            ):
                llm_runtime._get_prompt_llm_locked(config())

            self.assertIn("Failed to create llama_context", str(error.exception))
            self.assertIn("context_size=4096", str(error.exception))
            self.assertIn("flash_attn=True", str(error.exception))
            self.assertIn("swa_full=False", str(error.exception))
            self.assertIn("models.toml", str(error.exception))
        finally:
            llm_runtime.release_llm_runtime()

    async def test_generate_prompt_with_llm_applies_and_clears_thinking_override(self) -> None:
        for enabled in (True, False):
            with self.subTest(enabled=enabled):
                fake_llm = FakePromptCompletionLlm()
                with (
                    patch.object(llm_runtime, "build_prompt_llm_config", return_value=config()),
                    patch.object(llm_runtime, "acquire_gpu_model_multi", return_value=NullAsyncContext()),
                    patch.object(llm_runtime, "_get_prompt_llm_locked", return_value=fake_llm),
                ):
                    answer = await llm_runtime.generate_prompt_with_llm(
                        [{"role": "user", "content": "hello"}],
                        enable_thinking=enabled,
                        response_format_json=False,
                    )

                self.assertEqual(answer, "answer")
                self.assertIs(fake_llm.enable_thinking_override, enabled)
                self.assertFalse(hasattr(fake_llm, "_ai_slave_enable_thinking_override"))

    async def test_generate_prompt_with_llm_uses_model_default_when_think_is_omitted(self) -> None:
        fake_llm = FakePromptCompletionLlm()
        with (
            patch.object(llm_runtime, "build_prompt_llm_config", return_value=config()),
            patch.object(llm_runtime, "acquire_gpu_model_multi", return_value=NullAsyncContext()),
            patch.object(llm_runtime, "_get_prompt_llm_locked", return_value=fake_llm),
        ):
            answer = await llm_runtime.generate_prompt_with_llm(
                [{"role": "user", "content": "hello"}],
                response_format_json=False,
            )

        self.assertEqual(answer, "answer")
        self.assertIsNone(fake_llm.enable_thinking_override)
        self.assertFalse(hasattr(fake_llm, "_ai_slave_enable_thinking_override"))

    async def test_generate_prompt_with_llm_restores_previous_thinking_override(self) -> None:
        fake_llm = FakePromptCompletionLlm()
        fake_llm._ai_slave_enable_thinking_override = False
        with (
            patch.object(llm_runtime, "build_prompt_llm_config", return_value=config()),
            patch.object(llm_runtime, "acquire_gpu_model_multi", return_value=NullAsyncContext()),
            patch.object(llm_runtime, "_get_prompt_llm_locked", return_value=fake_llm),
        ):
            await llm_runtime.generate_prompt_with_llm(
                [{"role": "user", "content": "hello"}],
                enable_thinking=True,
                response_format_json=False,
            )

        self.assertIs(fake_llm.enable_thinking_override, True)
        self.assertIs(fake_llm._ai_slave_enable_thinking_override, False)

    async def test_generate_prompt_with_llm_clears_thinking_override_after_failure(self) -> None:
        fake_llm = FakePromptCompletionLlm(error=RuntimeError("completion failed"))
        with (
            patch.object(llm_runtime, "build_prompt_llm_config", return_value=config()),
            patch.object(llm_runtime, "acquire_gpu_model_multi", return_value=NullAsyncContext()),
            patch.object(llm_runtime, "_get_prompt_llm_locked", return_value=fake_llm),
        ):
            with self.assertRaisesRegex(RuntimeError, "completion failed"):
                await llm_runtime.generate_prompt_with_llm(
                    [{"role": "user", "content": "hello"}],
                    enable_thinking=True,
                    response_format_json=False,
                )

        self.assertIs(fake_llm.enable_thinking_override, True)
        self.assertFalse(hasattr(fake_llm, "_ai_slave_enable_thinking_override"))

    async def test_generate_prompt_with_llm_removes_gemma_and_qwen_reasoning(self) -> None:
        cases = {
            "gemma": "<|channel>thought\nsecret reasoning<channel|>final answer<turn|>",
            "qwen": "<think>secret reasoning</think>final answer",
            "qwen-closing-only": "secret reasoning</think>final answer",
        }
        for reasoning_format, content in cases.items():
            with self.subTest(reasoning_format=reasoning_format):
                fake_llm = FakePromptCompletionLlm(content)
                log = Mock()
                with (
                    patch.object(llm_runtime, "build_prompt_llm_config", return_value=config()),
                    patch.object(llm_runtime, "acquire_gpu_model_multi", return_value=NullAsyncContext()),
                    patch.object(llm_runtime, "_get_prompt_llm_locked", return_value=fake_llm),
                    patch.object(llm_runtime, "log", log),
                ):
                    answer = await llm_runtime.generate_prompt_with_llm(
                        [{"role": "user", "content": "hello"}],
                        enable_thinking=True,
                        response_format_json=False,
                    )

                self.assertEqual(answer, "final answer")
                self.assertNotIn("secret reasoning", " ".join(call.args[0] for call in log.call_args_list))

    async def test_generate_prompt_with_llm_rejects_unterminated_or_empty_reasoning_output(self) -> None:
        cases = (
            "<|channel>thought\nreasoning without end",
            "<think>reasoning without end",
            "reasoning</think>",
        )
        for content in cases:
            with self.subTest(content=content):
                fake_llm = FakePromptCompletionLlm(content)
                with (
                    patch.object(llm_runtime, "build_prompt_llm_config", return_value=config()),
                    patch.object(llm_runtime, "acquire_gpu_model_multi", return_value=NullAsyncContext()),
                    patch.object(llm_runtime, "_get_prompt_llm_locked", return_value=fake_llm),
                ):
                    with self.assertRaises(RuntimeError):
                        await llm_runtime.generate_prompt_with_llm(
                            [{"role": "user", "content": "hello"}],
                            enable_thinking=True,
                            response_format_json=False,
                        )

    async def test_generate_prompt_with_llm_validates_and_recovers_json_final(self) -> None:
        cases = {
            "strict": ('{"value":{"nested":true}}', '{"value":{"nested":true}}'),
            "recovered": (
                'Result:\n```json\n{"value":{"nested":true}}\n```',
                '{"value":{"nested":true}}',
            ),
            "reasoning-and-recovered": (
                '<|channel>thought\nsecret<channel|>Result: {"value":1}',
                '{"value":1}',
            ),
        }
        for name, (content, expected) in cases.items():
            with self.subTest(name=name):
                fake_llm = FakePromptCompletionLlm(content)
                with (
                    patch.object(llm_runtime, "build_prompt_llm_config", return_value=config()),
                    patch.object(llm_runtime, "acquire_gpu_model_multi", return_value=NullAsyncContext()),
                    patch.object(llm_runtime, "_get_prompt_llm_locked", return_value=fake_llm),
                ):
                    answer = await llm_runtime.generate_prompt_with_llm(
                        [{"role": "user", "content": "hello"}],
                        enable_thinking=True,
                        response_format_json=True,
                    )

                self.assertEqual(answer, expected)
                self.assertNotIn("response_format", fake_llm.kwargs)

    async def test_generate_prompt_with_llm_uses_json_grammar_without_thinking(self) -> None:
        fake_llm = FakePromptCompletionLlm('{"value":1}')
        with (
            patch.object(llm_runtime, "build_prompt_llm_config", return_value=config()),
            patch.object(llm_runtime, "acquire_gpu_model_multi", return_value=NullAsyncContext()),
            patch.object(llm_runtime, "_get_prompt_llm_locked", return_value=fake_llm),
        ):
            await llm_runtime.generate_prompt_with_llm(
                [{"role": "user", "content": "hello"}],
                enable_thinking=False,
                response_format_json=True,
            )

        self.assertEqual(fake_llm.kwargs["response_format"], {"type": "json_object"})

    async def test_generate_prompt_with_llm_rejects_ambiguous_or_non_object_json(self) -> None:
        cases = ('{"first":1} and {"second":2}', '[{"value":1}]', "no json")
        for content in cases:
            with self.subTest(content=content):
                fake_llm = FakePromptCompletionLlm(content)
                with (
                    patch.object(llm_runtime, "build_prompt_llm_config", return_value=config()),
                    patch.object(llm_runtime, "acquire_gpu_model_multi", return_value=NullAsyncContext()),
                    patch.object(llm_runtime, "_get_prompt_llm_locked", return_value=fake_llm),
                ):
                    with self.assertRaises(RuntimeError):
                        await llm_runtime.generate_prompt_with_llm(
                            [{"role": "user", "content": "hello"}],
                            enable_thinking=True,
                            response_format_json=True,
                        )

    async def test_generate_chat_with_llm_streams_ordered_deltas_and_returns_answer(self) -> None:
        fake_llm = FakeStreamingLlm(
            [
                {"choices": [{"delta": {"role": "assistant"}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": "안녕"}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": "하세요"}, "finish_reason": None}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            ]
        )
        events = []

        async def on_delta(delta: str) -> None:
            events.append(delta)

        with (
            patch.object(llm_chat, "build_prompt_llm_config", return_value=config()),
            patch.object(llm_chat, "acquire_gpu_model_multi", return_value=NullAsyncContext()),
            patch.object(llm_runtime, "_get_prompt_llm_locked", return_value=fake_llm),
            patch.object(llm_chat, "_create_chat_ram_cache", return_value=FakeCache()),
            patch.object(llm_chat, "monotonic", side_effect=[0.0, 0.01, 0.04]),
        ):
            result = await llm_chat.generate_chat_with_llm(
                [{"role": "user", "content": "hello"}],
                max_tokens=32,
                temperature=0.25,
                enable_thinking=True,
                on_delta=on_delta,
            )

        self.assertEqual(result.answer, "안녕하세요")
        self.assertEqual(result.context_window, 4096)
        self.assertGreater(result.prompt_tokens, 0)
        self.assertEqual(result.max_response_tokens, 32)
        self.assertEqual(result.remaining_tokens, 4096 - fake_llm.n_tokens)
        self.assertTrue(result.cache_enabled)
        self.assertEqual(fake_llm.set_cache_calls, 1)
        self.assertEqual(events, ["안녕하세요"])
        self.assertEqual(fake_llm.kwargs["stream"], True)
        self.assertEqual(fake_llm.kwargs["messages"], [{"role": "user", "content": "hello"}])
        self.assertEqual(fake_llm.kwargs["max_tokens"], 32)
        self.assertEqual(fake_llm.kwargs["temperature"], 0.25)
        self.assertIs(fake_llm.enable_thinking_override, True)
        self.assertFalse(hasattr(fake_llm, "_ai_slave_enable_thinking_override"))

    async def test_generate_chat_with_llm_hides_reasoning_from_stream_and_answer(self) -> None:
        fake_llm = FakeStreamingLlm(
            [
                {"choices": [{"delta": {"content": "<|channel>tho"}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": "ught\nsecret reasoning<chan"}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": "nel|>final "}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": "answer"}, "finish_reason": None}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            ]
        )
        events = []

        async def on_delta(delta: str) -> None:
            events.append(delta)

        with (
            patch.object(llm_chat, "build_prompt_llm_config", return_value=config()),
            patch.object(llm_chat, "acquire_gpu_model_multi", return_value=NullAsyncContext()),
            patch.object(llm_runtime, "_get_prompt_llm_locked", return_value=fake_llm),
            patch.object(llm_chat, "_create_chat_ram_cache", return_value=FakeCache()),
        ):
            result = await llm_chat.generate_chat_with_llm(
                [{"role": "system", "content": "system"}, {"role": "user", "content": "hello"}],
                enable_thinking=True,
                thinking_effort="low",
                on_delta=on_delta,
            )

        self.assertEqual(result.answer, "final answer")
        self.assertEqual("".join(events), "final answer")
        self.assertNotIn("secret reasoning", "".join(events))
        self.assertEqual(
            fake_llm.kwargs["messages"][0]["content"],
            f"system\n\n{llm_generation.LOW_THINKING_INSTRUCTION}",
        )

    async def test_generate_chat_with_llm_buffers_json_until_validated(self) -> None:
        fake_llm = FakeStreamingLlm(
            [
                {"choices": [{"delta": {"content": "reasoning</think>Result: "}, "finish_reason": None}]},
                {"choices": [{"delta": {"content": '{"value":1}'}, "finish_reason": None}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            ]
        )
        events = []

        async def on_delta(delta: str) -> None:
            events.append(delta)

        with (
            patch.object(llm_chat, "build_prompt_llm_config", return_value=config()),
            patch.object(llm_chat, "acquire_gpu_model_multi", return_value=NullAsyncContext()),
            patch.object(llm_runtime, "_get_prompt_llm_locked", return_value=fake_llm),
            patch.object(llm_chat, "_create_chat_ram_cache", return_value=FakeCache()),
        ):
            result = await llm_chat.generate_chat_with_llm(
                [{"role": "user", "content": "hello"}],
                enable_thinking=True,
                response_format="json",
                on_delta=on_delta,
            )

        self.assertEqual(result.answer, '{"value":1}')
        self.assertEqual(events, ['{"value":1}'])

    async def test_generate_chat_with_llm_rejects_empty_answer(self) -> None:
        fake_llm = FakeStreamingLlm(
            [
                {"choices": [{"delta": {"role": "assistant"}, "finish_reason": None}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            ]
        )

        with (
            patch.object(llm_chat, "build_prompt_llm_config", return_value=config()),
            patch.object(llm_chat, "acquire_gpu_model_multi", return_value=NullAsyncContext()),
            patch.object(llm_runtime, "_get_prompt_llm_locked", return_value=fake_llm),
            patch.object(llm_chat, "_create_chat_ram_cache", return_value=FakeCache()),
        ):
            with self.assertRaises(RuntimeError) as error:
                await llm_chat.generate_chat_with_llm([{"role": "user", "content": "hello"}])

        self.assertEqual(str(error.exception), "LLM returned no final answer after reasoning")

    def test_prepare_chat_messages_and_prune_live_in_llm_chat(self) -> None:
        memory = {}
        request = llm_chat.ChatRequest(system_prompt="system", prompt="first")

        state, messages = llm_chat.prepare_chat_messages(memory, "session-1", request)

        self.assertIs(state, memory[llm_chat.CHAT_MEMORY_KEY])
        self.assertEqual(messages, [{"role": "system", "content": "system"}, {"role": "user", "content": "first"}])
        state["messages"] = messages + [{"role": "assistant", "content": "answer"}]
        _state, followup = llm_chat.prepare_chat_messages(memory, "session-1", llm_chat.ChatRequest(prompt="second"))
        self.assertEqual(followup[-2:], [{"role": "assistant", "content": "answer"}, {"role": "user", "content": "second"}])
        with self.assertRaises(ValueError):
            llm_chat.prepare_chat_messages(
                memory,
                "session-1",
                llm_chat.ChatRequest(system_prompt="changed", prompt="third"),
            )

        long_messages = [{"role": "system", "content": "system"}] + [
            {"role": "user" if index % 2 == 0 else "assistant", "content": str(index)}
            for index in range(llm_chat.CHAT_MAX_HISTORY_MESSAGES + 8)
        ]
        pruned = llm_chat.prune_chat_messages(long_messages)
        self.assertEqual(pruned[0], {"role": "system", "content": "system"})
        self.assertLessEqual(len(pruned), llm_chat.CHAT_MAX_HISTORY_MESSAGES)
        self.assertEqual(pruned[-1], long_messages[-1])

    def test_ensure_chat_cache_calls_set_cache_once(self) -> None:
        fake_llm = FakeStreamingLlm([])

        with patch.object(llm_chat, "_create_chat_ram_cache", return_value=FakeCache()):
            self.assertTrue(llm_chat._ensure_chat_cache(fake_llm))
            self.assertTrue(llm_chat._ensure_chat_cache(fake_llm))

        self.assertEqual(fake_llm.set_cache_calls, 1)


if __name__ == "__main__":
    unittest.main()
