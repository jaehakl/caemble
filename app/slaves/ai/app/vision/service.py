from __future__ import annotations

from io import BytesIO
from typing import Literal

from PIL import Image, UnidentifiedImageError
from sdk.slave import DataChannelAttachment

from app.vision.models import (
    CLIP_MODEL_NAME,
    VISION_IMAGE_MAX_BYTES,
    WD14_MODEL_REPO,
    ClipEmbeddingResponse,
    ClipTextRequest,
    Wd14TagsResponse,
)
from app.vision.runtime import encode_clip_image, encode_clip_text, extract_wd14_tags


VISION_IMAGE_FORMATS = {"JPEG", "PNG", "WEBP"}
VISION_IMAGE_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}


async def analyze_image(
    analysis_type: Literal["clip", "wd14"],
    attachments: list[DataChannelAttachment],
) -> ClipEmbeddingResponse | Wd14TagsResponse:
    attachment_map: dict[str, DataChannelAttachment] = {}
    for attachment in attachments:
        if attachment.id in attachment_map:
            raise ValueError(f"duplicate request attachment id: {attachment.id}")
        if attachment.id != "image":
            raise ValueError(f"unsupported request attachment id: {attachment.id}")
        if len(attachment.data) > VISION_IMAGE_MAX_BYTES:
            raise ValueError(f"request attachment exceeds {VISION_IMAGE_MAX_BYTES} bytes: image")
        if attachment.size != len(attachment.data):
            raise ValueError("request attachment size mismatch: image")
        attachment_map[attachment.id] = attachment
    if "image" not in attachment_map:
        raise ValueError("missing required request attachment(s): image")

    attachment = attachment_map["image"]
    if attachment.mimeType and attachment.mimeType.lower() not in VISION_IMAGE_MIME_TYPES:
        raise ValueError("image attachment must be PNG, JPEG, or WebP")
    try:
        with Image.open(BytesIO(attachment.data)) as opened_image:
            if (opened_image.format or "").upper() not in VISION_IMAGE_FORMATS:
                raise ValueError("image attachment must be PNG, JPEG, or WebP")
            image = opened_image.convert("RGB")
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError) as exc:
        raise ValueError("image attachment is not a supported image") from exc

    if analysis_type == "clip":
        try:
            embedding = await encode_clip_image(image)
        except Exception as exc:
            raise RuntimeError(f"CLIP image analysis failed: {exc}") from exc
        return ClipEmbeddingResponse(
            model=CLIP_MODEL_NAME,
            embedding=embedding,
            dimensions=len(embedding),
        )

    try:
        prompt, keywords = await extract_wd14_tags(image)
    except Exception as exc:
        raise RuntimeError(f"WD14 tag analysis failed: {exc}") from exc
    return Wd14TagsResponse(model=WD14_MODEL_REPO, prompt=prompt, keywords=keywords)


async def analyze_clip_text(request: ClipTextRequest) -> ClipEmbeddingResponse:
    text = request.text.strip()
    if not text:
        raise ValueError("text is required")
    try:
        embedding = await encode_clip_text(text)
    except Exception as exc:
        raise RuntimeError(f"CLIP text analysis failed: {exc}") from exc
    return ClipEmbeddingResponse(
        model=CLIP_MODEL_NAME,
        embedding=embedding,
        dimensions=len(embedding),
    )
