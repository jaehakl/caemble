from __future__ import annotations

from io import BytesIO
from typing import Literal

from PIL import Image
from sdk.slave import DataChannelAttachment

from app.vision.models import (
    CLIP_MODEL_NAME,
    WD14_MODEL_REPO,
    ClipEmbeddingResponse,
    ClipTextRequest,
    Wd14TagsResponse,
)
from app.vision.runtime import encode_clip_image, encode_clip_text, extract_wd14_tags


async def analyze_image(
    analysis_type: Literal["clip", "wd14"],
    attachments: list[DataChannelAttachment],
) -> ClipEmbeddingResponse | Wd14TagsResponse:
    attachment_map = {attachment.id: attachment for attachment in attachments}
    attachment = attachment_map["image"]
    with Image.open(BytesIO(attachment.data)) as opened_image:
        image = opened_image.convert("RGB")

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
    try:
        embedding = await encode_clip_text(text)
    except Exception as exc:
        raise RuntimeError(f"CLIP text analysis failed: {exc}") from exc
    return ClipEmbeddingResponse(
        model=CLIP_MODEL_NAME,
        embedding=embedding,
        dimensions=len(embedding),
    )
