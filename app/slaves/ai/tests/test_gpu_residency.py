from __future__ import annotations

from io import BytesIO
import tempfile
import unittest
from unittest.mock import patch

from app import gpu_residency
from app.sdxl.models import SdxlT2IRequest
from app.model_catalog import SdxlModelConfig
from app.sdxl import service as image_service


def sdxl_model_config(path: str) -> SdxlModelConfig:
    return SdxlModelConfig(
        name="sdxl-1",
        path=path,
        controlnet_scribble_model_id="scribble-model",
        controlnet_openpose_model_id="pose-model",
        step=30,
        cfg=7.0,
        height=1024,
        width=1024,
        strength=1.0,
        max_chunk_size=1,
        seed_min=0,
        seed_max=2_147_483_647,
        sampler="euler",
        scheduler="",
        format="png",
        scribble_scale=0.6,
        scribble_guidance_start=0.0,
        scribble_guidance_end=0.6,
        pose_scale=0.9,
        pose_guidance_start=0.0,
        pose_guidance_end=0.8,
    )


class GpuResidencyTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        gpu_residency.reset_gpu_residency_for_tests()

    async def asyncTearDown(self) -> None:
        gpu_residency.reset_gpu_residency_for_tests()

    async def test_two_gpus_assign_llm_and_image_to_dedicated_devices(self) -> None:
        with patch.object(gpu_residency, "get_cuda_device_count", return_value=2):
            self.assertEqual(gpu_residency.get_llm_cuda_device_id(True), 0)
            self.assertEqual(gpu_residency.get_image_cuda_device_id(), 1)

    async def test_two_gpus_release_only_previous_llm_on_llm_key_change(self) -> None:
        released: list[tuple[str, int]] = []

        with patch.object(gpu_residency, "get_cuda_device_count", return_value=2):
            async with gpu_residency.acquire_gpu_model(
                "llm",
                0,
                ("llm-a",),
                lambda device_id: released.append(("llm-a", device_id)),
            ):
                pass
            async with gpu_residency.acquire_gpu_model(
                "image",
                1,
                ("image-a",),
                lambda device_id: released.append(("image-a", device_id)),
            ):
                pass
            async with gpu_residency.acquire_gpu_model(
                "llm",
                0,
                ("llm-b",),
                lambda device_id: released.append(("llm-b", device_id)),
            ):
                pass

        self.assertEqual(released, [("llm-a", 0)])

    async def test_two_gpus_release_only_previous_image_on_image_key_change(self) -> None:
        released: list[tuple[str, int]] = []

        with patch.object(gpu_residency, "get_cuda_device_count", return_value=2):
            async with gpu_residency.acquire_gpu_model(
                "llm",
                0,
                ("llm-a",),
                lambda device_id: released.append(("llm-a", device_id)),
            ):
                pass
            async with gpu_residency.acquire_gpu_model(
                "image",
                1,
                ("image-a",),
                lambda device_id: released.append(("image-a", device_id)),
            ):
                pass
            async with gpu_residency.acquire_gpu_model(
                "image",
                1,
                ("image-b",),
                lambda device_id: released.append(("image-b", device_id)),
            ):
                pass

        self.assertEqual(released, [("image-a", 1)])

    async def test_one_gpu_releases_llm_when_image_needs_gpu(self) -> None:
        released: list[tuple[str, int]] = []

        with patch.object(gpu_residency, "get_cuda_device_count", return_value=1):
            async with gpu_residency.acquire_gpu_model(
                "llm",
                0,
                ("llm-a",),
                lambda device_id: released.append(("llm-a", device_id)),
            ):
                pass
            async with gpu_residency.acquire_gpu_model(
                "image",
                0,
                ("image-a",),
                lambda device_id: released.append(("image-a", device_id)),
            ):
                pass

        self.assertEqual(released, [("llm-a", 0)])

    async def test_one_gpu_releases_image_when_llm_needs_gpu(self) -> None:
        released: list[tuple[str, int]] = []

        with patch.object(gpu_residency, "get_cuda_device_count", return_value=1):
            async with gpu_residency.acquire_gpu_model(
                "image",
                0,
                ("image-a",),
                lambda device_id: released.append(("image-a", device_id)),
            ):
                pass
            async with gpu_residency.acquire_gpu_model(
                "llm",
                0,
                ("llm-a",),
                lambda device_id: released.append(("llm-a", device_id)),
            ):
                pass

        self.assertEqual(released, [("image-a", 0)])

    async def test_cpu_llm_does_not_release_gpu_image(self) -> None:
        released: list[tuple[str, int]] = []

        with patch.object(gpu_residency, "get_cuda_device_count", return_value=1):
            async with gpu_residency.acquire_gpu_model(
                "image",
                0,
                ("image-a",),
                lambda device_id: released.append(("image-a", device_id)),
            ):
                pass
            async with gpu_residency.acquire_gpu_model(
                "llm",
                gpu_residency.get_llm_cuda_device_id(False),
                ("llm-cpu",),
                lambda device_id: released.append(("llm-cpu", device_id)),
            ):
                pass

        self.assertEqual(released, [])

    async def test_multi_gpu_lease_releases_models_on_all_participating_devices(self) -> None:
        released: list[tuple[str, int]] = []

        with patch.object(gpu_residency, "get_cuda_device_count", return_value=2):
            async with gpu_residency.acquire_gpu_model(
                "llm",
                0,
                ("llm-a",),
                lambda device_id: released.append(("llm-a", device_id)),
            ):
                pass
            async with gpu_residency.acquire_gpu_model(
                "image",
                1,
                ("image-a",),
                lambda device_id: released.append(("image-a", device_id)),
            ):
                pass
            async with gpu_residency.acquire_gpu_model_multi(
                "llm",
                (1, 0),
                ("llm-b",),
                lambda device_id: released.append(("llm-b", device_id)),
            ):
                pass

        self.assertEqual(released, [("llm-a", 0), ("image-a", 1)])

    async def test_single_gpu_lease_releases_multi_gpu_model_once_and_clears_all_devices(self) -> None:
        released: list[tuple[str, int]] = []

        with patch.object(gpu_residency, "get_cuda_device_count", return_value=2):
            async with gpu_residency.acquire_gpu_model_multi(
                "llm",
                (0, 1),
                ("llm-a",),
                lambda device_id: released.append(("llm-a", device_id)),
            ):
                pass
            async with gpu_residency.acquire_gpu_model(
                "image",
                1,
                ("image-a",),
                lambda device_id: released.append(("image-a", device_id)),
            ):
                pass
            async with gpu_residency.acquire_gpu_model(
                "image",
                0,
                ("image-b",),
                lambda device_id: released.append(("image-b", device_id)),
            ):
                pass

        self.assertEqual(released, [("llm-a", 1)])

    async def test_clip_wd14_and_sdxl_coexist_on_one_gpu(self) -> None:
        released: list[tuple[str, int]] = []

        with patch.object(gpu_residency, "get_cuda_device_count", return_value=1):
            for role in ("clip", "wd14", "sdxl"):
                async with gpu_residency.acquire_gpu_model(
                    role,
                    0,
                    (f"{role}-a",),
                    lambda device_id, role=role: released.append((role, device_id)),
                    exclusive=False,
                ):
                    pass

        self.assertEqual(released, [])
        self.assertEqual(set(gpu_residency._loaded_models_by_device[0]), {"clip", "wd14", "sdxl"})

    async def test_visual_slot_key_change_releases_only_same_slot(self) -> None:
        released: list[tuple[str, int]] = []

        with patch.object(gpu_residency, "get_cuda_device_count", return_value=1):
            for role in ("clip", "wd14", "sdxl"):
                async with gpu_residency.acquire_gpu_model(
                    role,
                    0,
                    (f"{role}-a",),
                    lambda device_id, role=role: released.append((role, device_id)),
                    exclusive=False,
                ):
                    pass
            async with gpu_residency.acquire_gpu_model(
                "sdxl",
                0,
                ("sdxl-b",),
                lambda device_id: released.append(("sdxl-b", device_id)),
                exclusive=False,
            ):
                pass

        self.assertEqual(released, [("sdxl", 0)])
        self.assertEqual(set(gpu_residency._loaded_models_by_device[0]), {"clip", "wd14", "sdxl"})

    async def test_exclusive_llm_releases_all_co_resident_visual_models(self) -> None:
        released: list[tuple[str, int]] = []

        with patch.object(gpu_residency, "get_cuda_device_count", return_value=1):
            for role in ("clip", "wd14", "sdxl"):
                async with gpu_residency.acquire_gpu_model(
                    role,
                    0,
                    (role,),
                    lambda device_id, role=role: released.append((role, device_id)),
                    exclusive=False,
                ):
                    pass
            async with gpu_residency.acquire_gpu_model(
                "llm",
                0,
                ("llm",),
                lambda device_id: released.append(("llm", device_id)),
            ):
                pass

        self.assertEqual(released, [("clip", 0), ("wd14", 0), ("sdxl", 0)])
        self.assertEqual(set(gpu_residency._loaded_models_by_device[0]), {"llm"})

    async def test_oom_eviction_releases_all_other_visual_slots(self) -> None:
        released: list[tuple[str, int]] = []

        with patch.object(gpu_residency, "get_cuda_device_count", return_value=1):
            for role in ("clip", "wd14"):
                async with gpu_residency.acquire_gpu_model(
                    role,
                    0,
                    (role,),
                    lambda device_id, role=role: released.append((role, device_id)),
                    exclusive=False,
                ):
                    pass
            lease = gpu_residency.acquire_gpu_model(
                "sdxl",
                0,
                ("sdxl",),
                lambda device_id: released.append(("sdxl", device_id)),
                exclusive=False,
            )
            async with lease:
                self.assertTrue(await lease.evict_co_resident_models())

        self.assertEqual(released, [("clip", 0), ("wd14", 0)])
        self.assertEqual(set(gpu_residency._loaded_models_by_device[0]), {"sdxl"})


class SdxlT2IRequestTest(unittest.TestCase):
    def test_request_model_does_not_expose_manual_device_id(self) -> None:
        self.assertNotIn("device_id", SdxlT2IRequest.model_fields)

    def test_request_model_exposes_output_format(self) -> None:
        self.assertIn("format", SdxlT2IRequest.model_fields)
        self.assertEqual(SdxlT2IRequest(prompts=["a prompt"]).format, "png")


class SdxlT2IServiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_generation_returns_requested_jpg_format(self) -> None:
        from PIL import Image

        with tempfile.NamedTemporaryFile() as ckpt_file:
            generated_image = Image.new("RGBA", (8, 8), (255, 0, 0, 128))
            model = sdxl_model_config(ckpt_file.name)

            with (
                patch.object(image_service, "resolve_sdxl_model", return_value=(model, ckpt_file.name)),
                patch.object(
                    image_service,
                    "generate_images_batch",
                    return_value=([generated_image], [123]),
                ),
            ):
                response = await image_service.generate_sdxl_t2i_images(
                    SdxlT2IRequest(prompts=["a prompt"], format="jpeg"),
                )

        self.assertEqual(response.count, 1)
        self.assertEqual(response.images[0].format, "jpg")
        with Image.open(BytesIO(response.images[0].image_bytes)) as encoded_image:
            self.assertEqual(encoded_image.format, "JPEG")
            self.assertEqual(encoded_image.mode, "RGB")

    async def test_generation_rejects_unsupported_format(self) -> None:
        model = sdxl_model_config("unused.safetensors")
        with (
            patch.object(image_service, "resolve_sdxl_model", return_value=(model, "unused.safetensors")),
            self.assertRaises(ValueError) as context,
        ):
            await image_service.generate_sdxl_t2i_images(SdxlT2IRequest(prompts=["a prompt"], format="webp"))

        self.assertEqual(str(context.exception), "unsupported image format")


if __name__ == "__main__":
    unittest.main()
