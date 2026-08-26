from __future__ import annotations

from io import BytesIO

from PIL import Image
from sdk.slave import DataChannelAttachment

from app.sdxl.models import (
    GeneratedImage,
    SdxlControlNetRequest,
    SdxlGenerationRequest,
    SdxlT2IRequest,
    SdxlT2IResponse,
)
from app.sdxl.runtime import generate_images_batch
from app.model_catalog import resolve_sdxl_model


SDXL_DEFAULT_FIELDS = (
    "step",
    "cfg",
    "height",
    "width",
    "strength",
    "max_chunk_size",
    "seed_min",
    "seed_max",
    "sampler",
    "scheduler",
    "clip_skip",
    "format",
    "scribble_scale",
    "scribble_guidance_start",
    "scribble_guidance_end",
    "pose_scale",
    "pose_guidance_start",
    "pose_guidance_end",
)


async def generate_sdxl_t2i_images(request: SdxlT2IRequest) -> SdxlT2IResponse:
    return await generate_sdxl_images(request, "t2i", [])


async def generate_sdxl_images(
    request: SdxlGenerationRequest,
    image_mode: str,
    attachments: list[DataChannelAttachment],
) -> SdxlT2IResponse:
    normalized_mode = image_mode.strip().lower()

    model, resolved_ckpt_path = resolve_sdxl_model(request.model)
    default_updates = {
        field: getattr(model, field)
        for field in SDXL_DEFAULT_FIELDS
        if field not in request.model_fields_set and hasattr(request, field)
    }
    if default_updates:
        request = request.model_copy(update=default_updates)

    prompts = [prompt.strip() for prompt in request.prompts]

    image_format = request.format.strip().lower()
    if image_format == "jpeg":
        image_format = "jpg"
    attachment_map = {attachment.id: attachment for attachment in attachments}
    target_size = request.width, request.height
    init_image = (
        _decode_attachment(attachment_map["image"], "image", "RGB", target_size, Image.Resampling.LANCZOS)
        if "image" in attachment_map
        else None
    )
    mask_image = (
        _decode_attachment(attachment_map["mask"], "mask", "L", target_size, Image.Resampling.NEAREST)
        if "mask" in attachment_map
        else None
    )

    control_images: list[Image.Image] = []
    controlnet_model_ids: list[str] = []
    controlnet_conditioning_scales: list[float] = []
    control_guidance_starts: list[float] = []
    control_guidance_ends: list[float] = []
    if normalized_mode.startswith("controlnet_"):
        request = request  # handler supplies SdxlControlNetRequest for ControlNet modes
        if "scribble" in attachment_map:
            scribble = _decode_attachment(
                attachment_map["scribble"],
                "scribble",
                "RGB",
                target_size,
                Image.Resampling.LANCZOS,
            )
            if scribble.getextrema() != ((255, 255), (255, 255), (255, 255)):
                model_id = model.controlnet_scribble_model_id.strip()
                control_images.append(scribble)
                controlnet_model_ids.append(model_id)
                controlnet_conditioning_scales.append(request.scribble_scale)
                control_guidance_starts.append(request.scribble_guidance_start)
                control_guidance_ends.append(request.scribble_guidance_end)
        if "pose" in attachment_map:
            model_id = model.controlnet_openpose_model_id.strip()
            control_images.append(
                _decode_attachment(
                    attachment_map["pose"],
                    "pose",
                    "RGB",
                    target_size,
                    Image.Resampling.LANCZOS,
                )
            )
            controlnet_model_ids.append(model_id)
            controlnet_conditioning_scales.append(request.pose_scale)
            control_guidance_starts.append(request.pose_guidance_start)
            control_guidance_ends.append(request.pose_guidance_end)

    prompt_count = len(prompts)
    negative_prompts = request.negative_prompts or [""] * prompt_count
    seeds = request.seeds or [None] * prompt_count
    init_images = [init_image] * prompt_count if init_image is not None else []
    mask_images = [mask_image] * prompt_count if mask_image is not None else []
    controlnet_images = [list(control_images) for _ in prompts] if control_images else []
    max_chunk_size = 1 if len(control_images) > 1 else request.max_chunk_size

    try:
        images, resolved_seeds = await generate_images_batch(
            resolved_ckpt_path,
            normalized_mode,
            prompts,
            negative_prompts,
            init_images,
            mask_images,
            controlnet_images,
            seeds,
            request.step,
            request.cfg,
            request.height,
            request.width,
            request.strength,
            max_chunk_size,
            request.seed_min,
            request.seed_max,
            request.sampler,
            request.scheduler,
            request.clip_skip,
            controlnet_model_ids,
            controlnet_conditioning_scales,
            control_guidance_starts,
            control_guidance_ends,
        )
    except (ValueError, RuntimeError):
        raise
    except Exception as exc:
        raise RuntimeError(f"SDXL image generation failed: {exc}") from exc

    response_images = [
        GeneratedImage(image_bytes=_encode_image(image, image_format), format=image_format, seed=seed)
        for image, seed in zip(images, resolved_seeds)
    ]
    return SdxlT2IResponse(model=model.name, images=response_images, count=len(response_images))


def _decode_attachment(
    attachment: DataChannelAttachment,
    label: str,
    mode: str,
    target_size: tuple[int, int],
    resample: Image.Resampling,
) -> Image.Image:
    del label
    with Image.open(BytesIO(attachment.data)) as opened_image:
        image = opened_image.convert(mode)
    if image.size != target_size:
        image = image.resize(target_size, resample)
    return image


def _encode_image(image: Image.Image, image_format: str) -> bytes:
    buffer = BytesIO()
    if image_format == "jpg":
        if image.mode != "RGB":
            image = image.convert("RGB")
        image.save(buffer, format="JPEG")
    else:
        image.save(buffer, format="PNG")
    return buffer.getvalue()
