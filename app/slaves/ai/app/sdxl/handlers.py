from __future__ import annotations

import time
from typing import Any

from sdk.slave import DataChannelAttachment, DataChannelMessage, SlaveApp, SlaveContext

from app.logging import log, log_exception
from app.message import reject_request_attachments
from app.model_catalog import get_model_list_payload
from app.sdxl.models import SdxlControlNetRequest, SdxlGenerationRequest, SdxlT2IRequest, SdxlT2IResponse
from app.sdxl.service import generate_sdxl_images, generate_sdxl_t2i_images


def register_handlers(app: SlaveApp) -> None:
    app.handler("ai.sdxl.t2i")(ai_sdxl_t2i)
    app.handler("ai.sdxl.i2i")(ai_sdxl_i2i)
    app.handler("ai.sdxl.inpaint")(ai_sdxl_inpaint)
    app.handler("ai.sdxl.controlnet.t2i")(ai_sdxl_controlnet_t2i)
    app.handler("ai.sdxl.controlnet.i2i")(ai_sdxl_controlnet_i2i)
    app.handler("ai.sdxl.controlnet.inpaint")(ai_sdxl_controlnet_inpaint)
    app.handler("ai.sdxl.models")(ai_sdxl_models)


async def ai_sdxl_models(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    reject_request_attachments(message)
    return DataChannelMessage(
        id=message.id,
        type="ai.sdxl.models.result",
        payload=get_model_list_payload("sdxl"),
    )


async def ai_sdxl_t2i(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    reject_request_attachments(message)
    request = SdxlT2IRequest.model_validate(message.payload)
    return await _run_sdxl_handler(message, context, request, "t2i")


async def ai_sdxl_i2i(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    request = SdxlGenerationRequest.model_validate(message.payload)
    return await _run_sdxl_handler(message, context, request, "i2i")


async def ai_sdxl_inpaint(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    request = SdxlGenerationRequest.model_validate(message.payload)
    return await _run_sdxl_handler(message, context, request, "inpaint")


async def ai_sdxl_controlnet_t2i(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    request = SdxlControlNetRequest.model_validate(message.payload)
    return await _run_sdxl_handler(message, context, request, "controlnet_t2i")


async def ai_sdxl_controlnet_i2i(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    request = SdxlControlNetRequest.model_validate(message.payload)
    return await _run_sdxl_handler(message, context, request, "controlnet_i2i")


async def ai_sdxl_controlnet_inpaint(
    message: DataChannelMessage,
    memory: dict[str, Any] | None,
    context: SlaveContext,
) -> DataChannelMessage:
    request = SdxlControlNetRequest.model_validate(message.payload)
    return await _run_sdxl_handler(message, context, request, "controlnet_inpaint")


async def _run_sdxl_handler(
    message: DataChannelMessage,
    context: SlaveContext,
    request: SdxlGenerationRequest,
    image_mode: str,
) -> DataChannelMessage:
    started_at = time.perf_counter()
    try:
        log(
            f"{message.type} start "
            f"session={context.session_id} "
            f"count={len(request.prompts)} "
            f"size={request.width}x{request.height} "
            f"step={request.step} "
            f"cfg={request.cfg} "
            f"format={request.format} "
            f"seeds={request.seeds or 'auto'}"
        )
        response = (
            await generate_sdxl_t2i_images(request)
            if image_mode == "t2i" and isinstance(request, SdxlT2IRequest)
            else await generate_sdxl_images(request, image_mode, message.attachments)
        )
        result = _build_sdxl_result(message, response)
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        total_bytes = sum(attachment.size or 0 for attachment in result.attachments)
        log(
            f"{message.type} complete "
            f"session={context.session_id} "
            f"duration_ms={duration_ms} "
            f"images={response.count} "
            f"bytes={total_bytes}"
        )
        return result
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        log_exception(f"{message.type} failed session={context.session_id} duration_ms={duration_ms}", exc)
        raise


def _build_sdxl_result(message: DataChannelMessage, response: SdxlT2IResponse) -> DataChannelMessage:
    payload_images = []
    attachments = []
    for index, image in enumerate(response.images, start=1):
        extension = "jpg" if image.format == "jpg" else "png"
        mime_type = "image/jpeg" if extension == "jpg" else "image/png"
        attachment_id = f"image-{index}"
        name = f"sdxl-{image.seed}.{extension}"
        attachments.append(
            DataChannelAttachment(
                id=attachment_id,
                name=name,
                mimeType=mime_type,
                size=len(image.image_bytes),
                data=image.image_bytes,
            )
        )
        payload_images.append(
            {
                "attachment_id": attachment_id,
                "name": name,
                "format": image.format,
                "mimeType": mime_type,
                "size": len(image.image_bytes),
                "seed": image.seed,
            }
        )
    return DataChannelMessage(
        id=message.id,
        type=f"{message.type}.result",
        payload={"model": response.model, "images": payload_images, "count": len(payload_images)},
        attachments=attachments,
    )
