from __future__ import annotations

from pydantic import BaseModel, Field, field_validator, model_validator


IMAGE_PROMPT_MAX_BYTES = 16 * 1024
IMAGE_BATCH_MAX_ITEMS = 8


class SdxlGenerationRequest(BaseModel):
    model: str | None = None
    prompts: list[str] = Field(min_length=1, max_length=IMAGE_BATCH_MAX_ITEMS)
    negative_prompts: list[str] | None = Field(default=None, max_length=IMAGE_BATCH_MAX_ITEMS)
    seeds: list[int | None] | None = Field(default=None, max_length=IMAGE_BATCH_MAX_ITEMS)
    step: int = Field(default=30, ge=1, le=150)
    cfg: float = Field(default=7.0, ge=0.0, le=30.0)
    height: int = Field(default=1024, ge=64, le=2048)
    width: int = Field(default=1024, ge=64, le=2048)
    strength: float = Field(default=1.0, ge=0.0, le=1.0)
    max_chunk_size: int = Field(default=1, ge=1, le=8)
    seed_min: int = Field(default=0, ge=0)
    seed_max: int = Field(default=2_147_483_647, ge=0)
    sampler: str = "euler"
    scheduler: str = ""
    clip_skip: int | None = Field(default=None, ge=1, le=12)
    format: str = "png"

    @field_validator("prompts", "negative_prompts")
    @classmethod
    def validate_image_prompts(cls, values: list[str] | None) -> list[str] | None:
        if values is not None and any(len(value.encode("utf-8")) > IMAGE_PROMPT_MAX_BYTES for value in values):
            raise ValueError(f"Image prompt exceeds {IMAGE_PROMPT_MAX_BYTES} bytes")
        return values


class SdxlT2IRequest(SdxlGenerationRequest):
    pass


class SdxlControlNetRequest(SdxlGenerationRequest):
    scribble_scale: float = Field(default=0.6, ge=0.0, le=2.0)
    scribble_guidance_start: float = Field(default=0.0, ge=0.0, le=1.0)
    scribble_guidance_end: float = Field(default=0.6, ge=0.0, le=1.0)
    pose_scale: float = Field(default=0.9, ge=0.0, le=2.0)
    pose_guidance_start: float = Field(default=0.0, ge=0.0, le=1.0)
    pose_guidance_end: float = Field(default=0.8, ge=0.0, le=1.0)

    @model_validator(mode="after")
    def validate_guidance_ranges(self) -> "SdxlControlNetRequest":
        if (
            {"scribble_guidance_start", "scribble_guidance_end"} <= self.model_fields_set
            and self.scribble_guidance_end < self.scribble_guidance_start
        ):
            raise ValueError("scribble guidance end must be greater than or equal to start")
        if (
            {"pose_guidance_start", "pose_guidance_end"} <= self.model_fields_set
            and self.pose_guidance_end < self.pose_guidance_start
        ):
            raise ValueError("pose guidance end must be greater than or equal to start")
        return self


class GeneratedImage(BaseModel):
    image_bytes: bytes
    format: str
    seed: int


class SdxlT2IResponse(BaseModel):
    model: str
    images: list[GeneratedImage]
    count: int
