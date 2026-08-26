from __future__ import annotations

from pydantic import BaseModel


class SdxlGenerationRequest(BaseModel):
    model: str | None = None
    prompts: list[str]
    negative_prompts: list[str] | None = None
    seeds: list[int | None] | None = None
    step: int = 30
    cfg: float = 7.0
    height: int = 1024
    width: int = 1024
    strength: float = 1.0
    max_chunk_size: int = 1
    seed_min: int = 0
    seed_max: int = 2_147_483_647
    sampler: str = "euler"
    scheduler: str = ""
    clip_skip: int | None = None
    format: str = "png"

class SdxlT2IRequest(SdxlGenerationRequest):
    pass


class SdxlControlNetRequest(SdxlGenerationRequest):
    scribble_scale: float = 0.6
    scribble_guidance_start: float = 0.0
    scribble_guidance_end: float = 0.6
    pose_scale: float = 0.9
    pose_guidance_start: float = 0.0
    pose_guidance_end: float = 0.8


class GeneratedImage(BaseModel):
    image_bytes: bytes
    format: str
    seed: int


class SdxlT2IResponse(BaseModel):
    model: str
    images: list[GeneratedImage]
    count: int
