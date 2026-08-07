from __future__ import annotations

from contextlib import redirect_stderr
from io import StringIO
import unittest
from unittest.mock import AsyncMock, patch

from sdk.slave import DataChannelAttachment, DataChannelMessage, SlaveContext

from app import __main__ as ai_slave
from app import embeddings, llm, sdxl, vision
from app.embeddings import handlers as embedding_handlers
from app.embeddings.models import EMBEDDING_TEXT_MAX_BYTES, EmbeddingRequest
from app.llm import handlers as llm_handlers
from app.llm.models import LlmRequest
from app.sdxl import handlers as sdxl_handlers
from app.sdxl.models import IMAGE_BATCH_MAX_ITEMS, SdxlT2IRequest
from app.vision.models import CLIP_TEXT_MAX_BYTES, ClipTextRequest


def context() -> SlaveContext:
    return SlaveContext(session_id="session-1", ttl_seconds=60)


class AiAppTest(unittest.IsolatedAsyncioTestCase):
    async def test_initialize_runs_modules_in_order(self) -> None:
        calls = []

        async def initialize_embeddings(context):
            calls.append("embeddings")

        async def initialize_llm(context):
            calls.append("llm")

        async def initialize_vision(context):
            calls.append("vision")

        async def initialize_sdxl(context):
            calls.append("sdxl")

        with (
            patch.object(ai_slave, "initialize_embeddings", initialize_embeddings),
            patch.object(ai_slave, "initialize_vision", initialize_vision),
            patch.object(ai_slave, "initialize_llm", initialize_llm),
            patch.object(ai_slave, "initialize_sdxl", initialize_sdxl),
        ):
            await ai_slave.initialize(None, context())

        self.assertEqual(calls, ["embeddings", "vision", "llm", "sdxl"])

    async def test_feature_initializers_warm_runtime_imports(self) -> None:
        with (
            patch.object(embeddings, "warmup_embedding_import") as warmup_embedding_import,
            patch.object(vision, "warmup_vision_imports") as warmup_vision_imports,
            patch.object(llm, "warmup_llm_import") as warmup_llm_import,
            patch.object(sdxl, "warmup_sdxl_imports") as warmup_sdxl_imports,
            redirect_stderr(StringIO()) as stderr,
        ):
            await embeddings.initialize(context())
            await vision.initialize(context())
            await llm.initialize(context())
            await sdxl.initialize(context())

        warmup_embedding_import.assert_called_once_with("startup")
        warmup_vision_imports.assert_called_once_with()
        warmup_llm_import.assert_called_once_with()
        warmup_sdxl_imports.assert_called_once_with()
        self.assertIn("ai initialize embedding import warmup complete", stderr.getvalue())
        self.assertIn("ai initialize vision import warmup complete", stderr.getvalue())
        self.assertIn("ai initialize LLM import warmup complete", stderr.getvalue())
        self.assertIn("ai initialize SDXL import warmup complete", stderr.getvalue())

    def test_registers_all_public_handlers(self) -> None:
        self.assertEqual(
            [handler.message_type for handler in ai_slave.app.handlers],
            [
                "ai.llm",
                "ai.chat",
                "ai.llm.models",
                "ai.embeddings",
                "ai.embeddings.batch",
                "ai.embeddings.models",
                "ai.clip.image",
                "ai.clip.text",
                "ai.wd14.tags",
                "ai.sdxl.t2i",
                "ai.sdxl.i2i",
                "ai.sdxl.inpaint",
                "ai.sdxl.controlnet.t2i",
                "ai.sdxl.controlnet.i2i",
                "ai.sdxl.controlnet.inpaint",
                "ai.sdxl.models",
                "ai.voicevox.speakers",
                "ai.voicevox.audio_query",
                "ai.voicevox.synthesis",
            ],
        )

    def test_non_llm_requests_reject_oversized_payloads(self) -> None:
        with self.assertRaises(ValueError):
            EmbeddingRequest(text="x" * (EMBEDDING_TEXT_MAX_BYTES + 1))
        with self.assertRaises(ValueError):
            SdxlT2IRequest(prompts=["prompt"] * (IMAGE_BATCH_MAX_ITEMS + 1))
        with self.assertRaises(ValueError):
            ClipTextRequest(text="x" * (CLIP_TEXT_MAX_BYTES + 1))

    def test_llm_request_accepts_large_text(self) -> None:
        prompt = "x" * (512 * 1024)
        self.assertEqual(LlmRequest(system_prompt="system", prompt=prompt).prompt, prompt)

    async def test_model_list_handlers_return_catalog_payloads(self) -> None:
        payload = {"default_model": "default", "models": [{"name": "default"}]}
        cases = (
            (llm_handlers, "ai.llm.models", "llm"),
            (embedding_handlers, "ai.embeddings.models", "embeddings"),
            (sdxl_handlers, "ai.sdxl.models", "sdxl"),
        )
        for handlers, message_type, family in cases:
            with self.subTest(message_type=message_type), patch.object(
                handlers,
                "get_model_list_payload",
                return_value=payload,
            ) as get_payload:
                response = await ai_slave.app.dispatch(
                    DataChannelMessage(id="call-1", type=message_type, payload={}),
                    context(),
                )

            self.assertEqual(response.type, f"{message_type}.result")
            self.assertEqual(response.payload, payload)
            get_payload.assert_called_once_with(family)

    async def test_handlers_reject_request_attachments(self) -> None:
        attachment = DataChannelAttachment(
            id="input-1",
            name="input.png",
            mimeType="image/png",
            data=b"input",
        )

        for message_type, payload in (
            ("ai.llm", {"system_prompt": "system", "prompt": "prompt"}),
            ("ai.chat", {"system_prompt": "system", "prompt": "prompt"}),
            ("ai.embeddings", {"text": "text"}),
            ("ai.embeddings.batch", {"texts": ["first", "second"]}),
            ("ai.llm.models", {}),
            ("ai.embeddings.models", {}),
            ("ai.clip.text", {"text": "text"}),
            ("ai.sdxl.t2i", {"prompts": ["prompt"]}),
            ("ai.sdxl.models", {}),
            ("ai.voicevox.speakers", {}),
            ("ai.voicevox.audio_query", {"text": "text", "speaker": 2}),
            ("ai.voicevox.synthesis", {"audio_query": {}, "speaker": 2}),
        ):
            with self.subTest(message_type=message_type):
                with self.assertRaises(ValueError) as error:
                    await ai_slave.app.dispatch(
                        DataChannelMessage(
                            id="call-1",
                            type=message_type,
                            payload=payload,
                            attachments=[attachment],
                        ),
                        context(),
                    )

                self.assertEqual(str(error.exception), f"{message_type} does not support request attachments")


if __name__ == "__main__":
    unittest.main()
