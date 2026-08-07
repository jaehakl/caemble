from __future__ import annotations

from contextlib import nullcontext
from io import BytesIO
import math
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from PIL import Image
from sdk.slave import DataChannelAttachment, DataChannelMessage, SlaveContext
import torch

from app import __main__ as ai_slave
from app.vision import handlers as vision_handlers
from app.vision import runtime as vision_runtime
from app.vision import service as vision_service
from app.vision.models import (
    CLIP_MODEL_NAME,
    VISION_IMAGE_MAX_BYTES,
    WD14_MODEL_REPO,
    ClipEmbeddingResponse,
    ClipTextRequest,
    Wd14TagsResponse,
)


def context() -> SlaveContext:
    return SlaveContext(session_id="session-1", ttl_seconds=60)


def image_attachment(
    *,
    attachment_id: str = "image",
    mime_type: str = "image/png",
    image_format: str = "PNG",
) -> DataChannelAttachment:
    buffer = BytesIO()
    Image.new("RGB", (8, 8), "white").save(buffer, format=image_format)
    return DataChannelAttachment(
        id=attachment_id,
        name=f"input.{image_format.lower()}",
        mimeType=mime_type,
        data=buffer.getvalue(),
    )


class VisionHandlerTest(unittest.IsolatedAsyncioTestCase):
    async def test_clip_image_returns_embedding_payload(self) -> None:
        response_model = ClipEmbeddingResponse(
            model=CLIP_MODEL_NAME,
            embedding=[0.1, 0.2],
            dimensions=2,
        )
        with patch.object(vision_handlers, "analyze_image", AsyncMock(return_value=response_model)):
            response = await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-1",
                    type="ai.clip.image",
                    payload={},
                    attachments=[image_attachment()],
                ),
                context(),
            )

        self.assertEqual(response.type, "ai.clip.image.result")
        self.assertEqual(
            response.payload,
            {"model": CLIP_MODEL_NAME, "embedding": [0.1, 0.2], "dimensions": 2},
        )
        self.assertEqual(response.attachments, [])

    async def test_clip_text_returns_embedding_payload(self) -> None:
        response_model = ClipEmbeddingResponse(
            model=CLIP_MODEL_NAME,
            embedding=[0.3, 0.4],
            dimensions=2,
        )
        with patch.object(vision_handlers, "analyze_clip_text", AsyncMock(return_value=response_model)):
            response = await ai_slave.app.dispatch(
                DataChannelMessage(id="call-1", type="ai.clip.text", payload={"text": "blue sky"}),
                context(),
            )

        self.assertEqual(response.type, "ai.clip.text.result")
        self.assertEqual(response.payload["model"], CLIP_MODEL_NAME)
        self.assertEqual(response.payload["embedding"], [0.3, 0.4])

    async def test_wd14_returns_prompt_and_keywords(self) -> None:
        response_model = Wd14TagsResponse(
            model=WD14_MODEL_REPO,
            prompt="character_name, blue_sky",
            keywords=["character_name", "blue_sky"],
        )
        with patch.object(vision_handlers, "analyze_image", AsyncMock(return_value=response_model)):
            response = await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-1",
                    type="ai.wd14.tags",
                    payload={},
                    attachments=[image_attachment()],
                ),
                context(),
            )

        self.assertEqual(response.type, "ai.wd14.tags.result")
        self.assertEqual(
            response.payload,
            {
                "model": WD14_MODEL_REPO,
                "prompt": "character_name, blue_sky",
                "keywords": ["character_name", "blue_sky"],
            },
        )


class VisionServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_clip_image_decodes_rgb_and_returns_dimensions(self) -> None:
        encode = AsyncMock(return_value=[0.1, 0.2, 0.3])
        with patch.object(vision_service, "encode_clip_image", encode):
            response = await vision_service.analyze_image("clip", [image_attachment()])

        self.assertEqual(response.model, CLIP_MODEL_NAME)
        self.assertEqual(response.dimensions, 3)
        encoded_image = encode.await_args.args[0]
        self.assertEqual(encoded_image.mode, "RGB")

    async def test_clip_text_strips_input(self) -> None:
        encode = AsyncMock(return_value=[0.1, 0.2])
        with patch.object(vision_service, "encode_clip_text", encode):
            response = await vision_service.analyze_clip_text(ClipTextRequest(text="  blue sky  "))

        self.assertEqual(response.dimensions, 2)
        encode.assert_awaited_once_with("blue sky")

    async def test_rejects_missing_duplicate_and_unsupported_attachments(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing required"):
            await vision_service.analyze_image("clip", [])
        with self.assertRaisesRegex(ValueError, "duplicate request attachment"):
            await vision_service.analyze_image("clip", [image_attachment(), image_attachment()])
        with self.assertRaisesRegex(ValueError, "unsupported request attachment"):
            await vision_service.analyze_image("clip", [image_attachment(attachment_id="mask")])

    async def test_rejects_size_mime_and_image_format_errors(self) -> None:
        mismatch = image_attachment()
        mismatch.size = len(mismatch.data) + 1
        with self.assertRaisesRegex(ValueError, "size mismatch"):
            await vision_service.analyze_image("clip", [mismatch])

        with self.assertRaisesRegex(ValueError, "must be PNG, JPEG, or WebP"):
            await vision_service.analyze_image(
                "clip",
                [image_attachment(mime_type="image/gif")],
            )

        invalid = DataChannelAttachment(
            id="image",
            name="invalid.png",
            mimeType="image/png",
            data=b"not-an-image",
        )
        with self.assertRaisesRegex(ValueError, "not a supported image"):
            await vision_service.analyze_image("clip", [invalid])

    async def test_rejects_oversized_image(self) -> None:
        oversized = DataChannelAttachment(
            id="image",
            name="large.png",
            mimeType="image/png",
            data=b"x" * (VISION_IMAGE_MAX_BYTES + 1),
        )
        with self.assertRaisesRegex(ValueError, "exceeds"):
            await vision_service.analyze_image("clip", [oversized])


class VisionRuntimeTest(unittest.IsolatedAsyncioTestCase):
    def tearDown(self) -> None:
        vision_runtime.reset_vision_runtime_for_tests()

    def test_clip_image_embedding_is_l2_normalized(self) -> None:
        class Model:
            def encode_image(self, _image):
                return torch.arange(1, 769, dtype=torch.float32).unsqueeze(0)

        bundle = (
            Model(),
            lambda _image: torch.zeros(3, 8, 8),
            None,
            torch,
            "cpu",
        )
        with patch.object(vision_runtime, "_get_clip_bundle_locked", return_value=bundle):
            embedding = vision_runtime._encode_clip_image_locked(
                Image.new("RGB", (8, 8), "white"),
                "cpu",
            )

        self.assertEqual(len(embedding), 768)
        self.assertAlmostEqual(math.sqrt(sum(value * value for value in embedding)), 1.0, places=5)

    def test_clip_text_embedding_truncates_and_normalizes(self) -> None:
        tokenize_calls = []

        class Model:
            def encode_text(self, _tokens):
                return torch.arange(1, 769, dtype=torch.float32).unsqueeze(0)

        clip = SimpleNamespace(
            tokenize=lambda texts, truncate: (
                tokenize_calls.append((texts, truncate))
                or torch.zeros((len(texts), 77), dtype=torch.int64)
            )
        )
        bundle = Model(), None, clip, torch, "cpu"
        with patch.object(vision_runtime, "_get_clip_bundle_locked", return_value=bundle):
            embedding = vision_runtime._encode_clip_text_locked("blue sky", "cpu")

        self.assertEqual(tokenize_calls, [(["blue sky"], True)])
        self.assertAlmostEqual(math.sqrt(sum(value * value for value in embedding)), 1.0, places=5)

    def test_wd14_thresholds_sort_and_exclude_other_categories(self) -> None:
        labels = [
            ("safe", 9),
            ("blue_sky", 0),
            ("character_name", 4),
            ("low_score", 0),
        ]
        probabilities = torch.tensor([0.99, 0.36, 0.86, 0.20])

        class Model:
            def __call__(self, _image):
                return torch.logit(probabilities).unsqueeze(0)

        bundle = Model(), lambda _image: torch.zeros(3, 8, 8), labels, torch, "cpu"
        with patch.object(vision_runtime, "_get_wd14_bundle_locked", return_value=bundle):
            prompt, keywords = vision_runtime._extract_wd14_tags_locked(
                Image.new("RGB", (8, 8), "white"),
                "cpu",
            )

        self.assertEqual(keywords, ["character_name", "blue_sky"])
        self.assertEqual(prompt, "character_name, blue_sky")

    async def test_cuda_oom_evicts_co_residents_and_retries_once(self) -> None:
        class Lease:
            def __init__(self):
                self.evictions = 0

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, traceback):
                return None

            async def evict_co_resident_models(self):
                self.evictions += 1
                return True

        class Cuda:
            OutOfMemoryError = torch.cuda.OutOfMemoryError

            @staticmethod
            def is_available():
                return True

            @staticmethod
            def device_count():
                return 1

            @staticmethod
            def device(_device_id):
                return nullcontext()

            @staticmethod
            def empty_cache():
                return None

        lease = Lease()
        operation = Mock(side_effect=[torch.cuda.OutOfMemoryError("oom"), [0.1, 0.2]])
        fake_torch = SimpleNamespace(cuda=Cuda())
        with (
            patch.object(vision_runtime, "_load_torch", return_value=fake_torch),
            patch.object(vision_runtime, "_resolve_device", return_value=(0, "cuda:0")),
            patch.object(vision_runtime, "acquire_gpu_model", return_value=lease),
            patch.object(vision_runtime, "_encode_clip_image_locked", operation),
        ):
            embedding = await vision_runtime.encode_clip_image(Image.new("RGB", (8, 8)))

        self.assertEqual(embedding, [0.1, 0.2])
        self.assertEqual(operation.call_count, 2)
        self.assertEqual(lease.evictions, 1)


if __name__ == "__main__":
    unittest.main()
