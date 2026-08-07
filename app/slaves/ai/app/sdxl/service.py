from __future__ import annotations

from io import BytesIO

from PIL import Image, UnidentifiedImageError
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


SDXL_INPUT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
SDXL_INPUT_ATTACHMENT_IDS = {"image", "mask", "scribble", "pose"}
SDXL_IMAGE_FORMATS = {"JPEG", "PNG", "WEBP"}
SDXL_IMAGE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}
SDXL_IMAGE_MODES = {
    "t2i",
    "i2i",
    "inpaint",
    "controlnet_t2i",
    "controlnet_i2i",
    "controlnet_inpaint",
}
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
    if normalized_mode not in SDXL_IMAGE_MODES:
        raise ValueError(f"unsupported image generation mode: {image_mode}")

    model, resolved_ckpt_path = resolve_sdxl_model(request.model)
    default_updates = {
        field: getattr(model, field)
        for field in SDXL_DEFAULT_FIELDS
        if field not in request.model_fields_set and hasattr(request, field)
    }
    if default_updates:
        request = request.model_copy(update=default_updates)

    prompts = [prompt.strip() for prompt in request.prompts]
    if any(not prompt for prompt in prompts):
        raise ValueError("prompts must not contain blank values")
    if request.negative_prompts is not None and len(request.negative_prompts) != len(prompts):
        raise ValueError("negative_prompts length must match prompts length")
    if request.seeds is not None and len(request.seeds) != len(prompts):
        raise ValueError("seeds length must match prompts length")
    if request.seed_min > request.seed_max:
        raise ValueError("seed_min must be less than or equal to seed_max")
    if request.height % 8 != 0 or request.width % 8 != 0:
        raise ValueError("height and width must be multiples of 8")
    if isinstance(request, SdxlControlNetRequest):
        if request.scribble_guidance_end < request.scribble_guidance_start:
            raise ValueError("scribble guidance end must be greater than or equal to start")
        if request.pose_guidance_end < request.pose_guidance_start:
            raise ValueError("pose guidance end must be greater than or equal to start")

    image_format = request.format.strip().lower()
    if image_format == "jpeg":
        image_format = "jpg"
    if image_format not in {"png", "jpg"}:
        raise ValueError("unsupported image format")

    attachment_map = _validate_attachments(normalized_mode, attachments)
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
        if not isinstance(request, SdxlControlNetRequest):
            raise ValueError("ControlNet settings are required")
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
                if not model_id:
                    raise RuntimeError("controlnet_scribble_model_id is required")
                control_images.append(scribble)
                controlnet_model_ids.append(model_id)
                controlnet_conditioning_scales.append(request.scribble_scale)
                control_guidance_starts.append(request.scribble_guidance_start)
                control_guidance_ends.append(request.scribble_guidance_end)
        if "pose" in attachment_map:
            model_id = model.controlnet_openpose_model_id.strip()
            if not model_id:
                raise RuntimeError("controlnet_openpose_model_id is required")
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
        if not control_images:
            raise ValueError("at least one active scribble or pose attachment is required")

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
        for image, seed in zip(images, resolved_seeds, strict=True)
    ]
    return SdxlT2IResponse(model=model.name, images=response_images, count=len(response_images))


def _validate_attachments(
    image_mode: str,
    attachments: list[DataChannelAttachment],
) -> dict[str, DataChannelAttachment]:
    attachment_map: dict[str, DataChannelAttachment] = {}
    for attachment in attachments:
        if attachment.id in attachment_map:
            raise ValueError(f"duplicate request attachment id: {attachment.id}")
        if attachment.id not in SDXL_INPUT_ATTACHMENT_IDS:
            raise ValueError(f"unsupported request attachment id: {attachment.id}")
        if len(attachment.data) > SDXL_INPUT_ATTACHMENT_MAX_BYTES:
            raise ValueError(f"request attachment exceeds {SDXL_INPUT_ATTACHMENT_MAX_BYTES} bytes: {attachment.id}")
        if attachment.size != len(attachment.data):
            raise ValueError(f"request attachment size mismatch: {attachment.id}")
        attachment_map[attachment.id] = attachment

    required: set[str]
    allowed: set[str]
    if image_mode == "t2i":
        required, allowed = set(), set()
    elif image_mode == "i2i":
        required = allowed = {"image"}
    elif image_mode == "inpaint":
        required = allowed = {"image", "mask"}
    elif image_mode == "controlnet_t2i":
        required, allowed = set(), {"scribble", "pose"}
    elif image_mode == "controlnet_i2i":
        required, allowed = {"image"}, {"image", "scribble", "pose"}
    else:
        required, allowed = {"image", "mask"}, {"image", "mask", "scribble", "pose"}

    missing = sorted(required - attachment_map.keys())
    if missing:
        raise ValueError(f"missing required request attachment(s): {', '.join(missing)}")
    unexpected = sorted(attachment_map.keys() - allowed)
    if unexpected:
        raise ValueError(f"unexpected request attachment(s): {', '.join(unexpected)}")
    if image_mode.startswith("controlnet_") and not ({"scribble", "pose"} & attachment_map.keys()):
        raise ValueError("scribble or pose request attachment is required")
    return attachment_map


def _decode_attachment(
    attachment: DataChannelAttachment,
    label: str,
    mode: str,
    target_size: tuple[int, int],
    resample: Image.Resampling,
) -> Image.Image:
    if attachment.mimeType and attachment.mimeType.lower() not in SDXL_IMAGE_MIME_TYPES:
        raise ValueError(f"{label} attachment must be PNG, JPEG, or WebP")
    try:
        with Image.open(BytesIO(attachment.data)) as opened_image:
            if (opened_image.format or "").upper() not in SDXL_IMAGE_FORMATS:
                raise ValueError(f"{label} attachment must be PNG, JPEG, or WebP")
            image = opened_image.convert(mode)
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError) as exc:
        raise ValueError(f"{label} attachment is not a supported image") from exc
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
