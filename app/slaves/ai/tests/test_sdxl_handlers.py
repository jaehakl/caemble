from __future__ import annotations

from contextlib import nullcontext, redirect_stderr, redirect_stdout
from io import BytesIO, StringIO
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from PIL import Image
from sdk.slave import DataChannelAttachment, DataChannelMessage, SlaveContext
import torch

from app import __main__ as ai_slave
from app.sdxl import handlers as sdxl_handlers
from app.sdxl import runtime as sdxl_runtime
from app.sdxl import service as sdxl_service
from app.sdxl.models import (
    GeneratedImage,
    SdxlControlNetRequest,
    SdxlGenerationRequest,
    SdxlT2IRequest,
    SdxlT2IResponse,
)
from app.model_catalog import SdxlModelConfig


def context() -> SlaveContext:
    return SlaveContext(session_id="session-1", ttl_seconds=60)


def sdxl_model_config(path: str, **updates) -> SdxlModelConfig:
    values = {
        "name": "sdxl-1",
        "path": path,
        "controlnet_scribble_model_id": "xinsir/controlnet-scribble-sdxl-1.0",
        "controlnet_openpose_model_id": "xinsir/controlnet-openpose-sdxl-1.0",
        "step": 30,
        "cfg": 7.0,
        "height": 1024,
        "width": 1024,
        "strength": 1.0,
        "max_chunk_size": 1,
        "seed_min": 0,
        "seed_max": 2_147_483_647,
        "sampler": "euler",
        "scheduler": "",
        "format": "png",
        "scribble_scale": 0.6,
        "scribble_guidance_start": 0.0,
        "scribble_guidance_end": 0.6,
        "pose_scale": 0.9,
        "pose_guidance_start": 0.0,
        "pose_guidance_end": 0.8,
    }
    values.update(updates)
    return SdxlModelConfig.model_validate(values)


class SdxlHandlerTest(unittest.IsolatedAsyncioTestCase):
    async def test_returns_image_attachments_without_base64_payload(self) -> None:
        image_bytes = b"image-bytes"
        generate_images = AsyncMock(
            return_value=SdxlT2IResponse(
                model="sdxl-1",
                images=[GeneratedImage(image_bytes=image_bytes, format="png", seed=123)],
                count=1,
            )
        )

        with patch.object(sdxl_handlers, "generate_sdxl_t2i_images", generate_images):
            response = await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-1",
                    type="ai.sdxl.t2i",
                    payload={"prompts": ["a small image"]},
                ),
                context(),
            )

        self.assertEqual(response.type, "ai.sdxl.t2i.result")
        self.assertEqual(response.payload["count"], 1)
        self.assertEqual(response.payload["model"], "sdxl-1")
        self.assertNotIn("image_base64", response.payload["images"][0])
        self.assertEqual(
            response.payload["images"][0],
            {
                "attachment_id": "image-1",
                "name": "sdxl-123.png",
                "format": "png",
                "mimeType": "image/png",
                "size": len(image_bytes),
                "seed": 123,
            },
        )
        self.assertEqual(response.attachments[0].data, image_bytes)
        generate_images.assert_awaited_once()

    async def test_i2i_returns_mode_specific_result_type(self) -> None:
        generate_images = AsyncMock(
            return_value=SdxlT2IResponse(
                model="sdxl-1",
                images=[GeneratedImage(image_bytes=b"output", format="png", seed=5)],
                count=1,
            )
        )
        attachment = DataChannelAttachment(id="image", mimeType="image/png", data=b"input")

        with patch.object(sdxl_handlers, "generate_sdxl_images", generate_images):
            response = await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-1",
                    type="ai.sdxl.i2i",
                    payload={"prompts": ["a prompt"]},
                    attachments=[attachment],
                ),
                context(),
            )

        self.assertEqual(response.type, "ai.sdxl.i2i.result")
        self.assertEqual(response.attachments[0].data, b"output")
        generate_images.assert_awaited_once()
        self.assertEqual(generate_images.await_args.args[1], "i2i")
        self.assertEqual(generate_images.await_args.args[2], [attachment])

    def test_model_loading_logs_to_stderr_not_stdout(self) -> None:
        class FakeTorch:
            float16 = "float16"

        class FakePipeline:
            @classmethod
            def from_single_file(cls, *args, **kwargs):
                return cls()

            def to(self, device):
                self.device = device

            def enable_attention_slicing(self):
                self.attention_slicing = True

            def enable_vae_slicing(self):
                self.vae_slicing = True

        stdout = StringIO()
        stderr = StringIO()
        sdxl_runtime._reset_image_runtime_for_tests()
        try:
            with (
                patch.object(sdxl_runtime, "_load_diffusers_attr", return_value=FakePipeline),
                patch.object(sdxl_runtime, "_cuda_device_name", return_value="cuda:0"),
                redirect_stdout(stdout),
                redirect_stderr(stderr),
            ):
                sdxl_runtime._get_image_pipe_locked("checkpoint.safetensors", "t2i", [], FakeTorch, 0)
        finally:
            sdxl_runtime._reset_image_runtime_for_tests()

        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("loading Stable Diffusion t2i checkpoint", stderr.getvalue())

    def test_runtime_selects_pipeline_for_every_supported_mode(self) -> None:
        class FakeTorch:
            float16 = "float16"

        class FakePipelineBase:
            @classmethod
            def from_single_file(cls, *args, **kwargs):
                return cls()

            def to(self, device):
                self.device = device

            def enable_attention_slicing(self):
                pass

            def enable_vae_slicing(self):
                pass

        class T2IPipeline(FakePipelineBase):
            pass

        class I2IPipeline(FakePipelineBase):
            pass

        class InpaintPipeline(FakePipelineBase):
            pass

        class ControlT2IPipeline(FakePipelineBase):
            pass

        class ControlI2IPipeline(FakePipelineBase):
            pass

        class ControlInpaintPipeline(FakePipelineBase):
            pass

        class FakeControlNet:
            @classmethod
            def from_pretrained(cls, *args, **kwargs):
                return cls()

        ordinary = {
            "StableDiffusionXLPipeline": T2IPipeline,
            "StableDiffusionXLImg2ImgPipeline": I2IPipeline,
            "StableDiffusionXLInpaintPipeline": InpaintPipeline,
        }
        expected = {
            "t2i": T2IPipeline,
            "i2i": I2IPipeline,
            "inpaint": InpaintPipeline,
            "controlnet_t2i": ControlT2IPipeline,
            "controlnet_i2i": ControlI2IPipeline,
            "controlnet_inpaint": ControlInpaintPipeline,
        }
        for mode, expected_type in expected.items():
            with self.subTest(mode=mode):
                sdxl_runtime._reset_image_runtime_for_tests()
                with (
                    patch.object(sdxl_runtime, "_load_diffusers_attr", side_effect=lambda name: ordinary[name]),
                    patch.object(
                        sdxl_runtime,
                        "_load_diffusers_attrs",
                        return_value=(
                            FakeControlNet,
                            ControlI2IPipeline,
                            ControlInpaintPipeline,
                            ControlT2IPipeline,
                        ),
                    ),
                    patch.object(sdxl_runtime, "_cuda_device_name", return_value="cuda:0"),
                ):
                    pipe = sdxl_runtime._get_image_pipe_locked(
                        "checkpoint.safetensors",
                        mode,
                        ["control-model"] if mode.startswith("controlnet_") else [],
                        FakeTorch,
                        0,
                    )
                self.assertIsInstance(pipe, expected_type)
        sdxl_runtime._reset_image_runtime_for_tests()


class SdxlServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_model_defaults_apply_and_explicit_request_values_win(self) -> None:
        model = sdxl_model_config(
            "unused.safetensors",
            name="sdxl-defaults",
            step=12,
            cfg=4.5,
            height=64,
            width=64,
        )
        generated = Image.new("RGB", (8, 8), (1, 2, 3))
        generate_images = AsyncMock(return_value=([generated], [7]))
        with (
            patch.object(sdxl_service, "resolve_sdxl_model", return_value=(model, "unused.safetensors")),
            patch.object(sdxl_service, "generate_images_batch", generate_images),
        ):
            response = await sdxl_service.generate_sdxl_t2i_images(
                SdxlT2IRequest(prompts=["prompt"], width=128),
            )

        args = generate_images.await_args.args
        self.assertEqual(args[8], 12)
        self.assertEqual(args[9], 4.5)
        self.assertEqual(args[10], 64)
        self.assertEqual(args[11], 128)
        self.assertEqual(response.model, "sdxl-defaults")

    async def test_controlnet_inpaint_broadcasts_inputs_and_keeps_control_order(self) -> None:
        with tempfile.NamedTemporaryFile() as ckpt_file:
            generated = Image.new("RGB", (8, 8), (1, 2, 3))
            generate_images = AsyncMock(return_value=([generated, generated], [10, 11]))
            attachments = [
                make_image_attachment("image", "RGB", (10, 20, 30)),
                make_image_attachment("mask", "L", 255),
                make_image_attachment("scribble", "RGB", (0, 0, 0)),
                make_image_attachment("pose", "RGB", (30, 20, 10)),
            ]
            request = SdxlControlNetRequest(
                prompts=["first", "second"],
                width=64,
                height=64,
                max_chunk_size=8,
            )
            model = sdxl_model_config(
                ckpt_file.name,
                controlnet_scribble_model_id="scribble-model",
                controlnet_openpose_model_id="pose-model",
            )

            with (
                patch.object(sdxl_service, "resolve_sdxl_model", return_value=(model, ckpt_file.name)),
                patch.object(sdxl_service, "generate_images_batch", generate_images),
            ):
                response = await sdxl_service.generate_sdxl_images(
                    request,
                    "controlnet_inpaint",
                    attachments,
                )

        args = generate_images.await_args.args
        self.assertEqual(args[1], "controlnet_inpaint")
        self.assertEqual(len(args[4]), 2)
        self.assertEqual(len(args[5]), 2)
        self.assertEqual([image.size for image in args[4]], [(64, 64), (64, 64)])
        self.assertEqual([image.size for image in args[5]], [(64, 64), (64, 64)])
        self.assertEqual([len(images) for images in args[6]], [2, 2])
        self.assertEqual(args[13], 1)
        self.assertEqual(args[19], ["scribble-model", "pose-model"])
        self.assertEqual(args[20], [0.6, 0.9])
        self.assertEqual(args[21], [0.0, 0.0])
        self.assertEqual(args[22], [0.6, 0.8])
        self.assertEqual(response.count, 2)

    async def test_controlnet_rejects_blank_scribble_without_pose(self) -> None:
        with tempfile.NamedTemporaryFile() as ckpt_file:
            model = sdxl_model_config(ckpt_file.name)
            with patch.object(sdxl_service, "resolve_sdxl_model", return_value=(model, ckpt_file.name)):
                with self.assertRaises(ValueError) as error:
                    await sdxl_service.generate_sdxl_images(
                        SdxlControlNetRequest(prompts=["prompt"], width=64, height=64),
                        "controlnet_t2i",
                        [make_image_attachment("scribble", "RGB", (255, 255, 255))],
                    )

        self.assertIn("at least one active", str(error.exception))

    async def test_i2i_requires_fixed_image_attachment(self) -> None:
        with tempfile.NamedTemporaryFile() as ckpt_file:
            model = sdxl_model_config(ckpt_file.name)
            with patch.object(sdxl_service, "resolve_sdxl_model", return_value=(model, ckpt_file.name)):
                with self.assertRaises(ValueError) as error:
                    await sdxl_service.generate_sdxl_images(
                        SdxlGenerationRequest(prompts=["prompt"]),
                        "i2i",
                        [],
                    )

        self.assertIn("image", str(error.exception))

    async def test_i2i_rejects_unexpected_control_attachment(self) -> None:
        with tempfile.NamedTemporaryFile() as ckpt_file:
            model = sdxl_model_config(ckpt_file.name)
            with patch.object(sdxl_service, "resolve_sdxl_model", return_value=(model, ckpt_file.name)):
                with self.assertRaises(ValueError) as error:
                    await sdxl_service.generate_sdxl_images(
                        SdxlGenerationRequest(prompts=["prompt"]),
                        "i2i",
                        [
                            make_image_attachment("image", "RGB", (0, 0, 0)),
                            make_image_attachment("pose", "RGB", (0, 0, 0)),
                        ],
                    )

        self.assertIn("unexpected request attachment", str(error.exception))

    def test_controlnet_rejects_reversed_guidance_range(self) -> None:
        with self.assertRaises(ValueError) as error:
            SdxlControlNetRequest(
                prompts=["prompt"],
                scribble_guidance_start=0.8,
                scribble_guidance_end=0.2,
            )

        self.assertIn("scribble guidance end", str(error.exception))


class SdxlRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_cuda_oom_evicts_co_residents_and_retries_only_once(self) -> None:
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

        generated = ([Image.new("RGB", (8, 8))], [7])
        cases = (
            ([torch.cuda.OutOfMemoryError("oom"), generated], False),
            ([torch.cuda.OutOfMemoryError("oom"), torch.cuda.OutOfMemoryError("oom again")], True),
        )
        for side_effect, should_fail in cases:
            with self.subTest(should_fail=should_fail):
                lease = Lease()
                operation = Mock(side_effect=side_effect)
                acquire = Mock(return_value=lease)
                fake_torch = SimpleNamespace(cuda=Cuda())
                with (
                    patch.object(sdxl_runtime, "_load_image_torch", return_value=fake_torch),
                    patch.object(sdxl_runtime, "get_image_cuda_device_id", return_value=0),
                    patch.object(sdxl_runtime, "acquire_gpu_model", acquire),
                    patch.object(sdxl_runtime, "_generate_images_batch_locked", operation),
                ):
                    call = sdxl_runtime.generate_images_batch(
                        "model.safetensors",
                        "t2i",
                        ["prompt"],
                        [""],
                        [],
                        [],
                        [],
                        [7],
                        1,
                        7.0,
                        64,
                        64,
                        1.0,
                        1,
                        0,
                        10,
                        "euler",
                        "",
                        None,
                        [],
                        [],
                        [],
                        [],
                    )
                    if should_fail:
                        with self.assertRaises(torch.cuda.OutOfMemoryError):
                            await call
                    else:
                        self.assertEqual(await call, generated)

                self.assertEqual(operation.call_count, 2)
                self.assertEqual(lease.evictions, 1)
                acquire.assert_called_once_with(
                    "sdxl",
                    0,
                    ("model.safetensors", "t2i", None),
                    sdxl_runtime.release_image_runtime,
                    exclusive=False,
                )


def make_image_attachment(
    attachment_id: str,
    mode: str,
    color: int | tuple[int, int, int],
) -> DataChannelAttachment:
    image = Image.new(mode, (4, 4), color)
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return DataChannelAttachment(
        id=attachment_id,
        name=f"{attachment_id}.png",
        mimeType="image/png",
        data=buffer.getvalue(),
    )


if __name__ == "__main__":
    unittest.main()
