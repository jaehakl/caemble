from __future__ import annotations

from typing import Any

from pydantic import BaseModel, field_validator, model_validator

from app.llm.generation import ResponseFormat, ThinkingEffort


REFERENCE_CONTEXT_MAX_BYTES = 128 * 1024


class GenerationRequest(BaseModel):
    model: str | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    context_size: int | None = None
    top_p: float | None = None
    think: bool | None = None
    thinking_effort: ThinkingEffort = "default"
    response_format: ResponseFormat = "text"

    @model_validator(mode="before")
    @classmethod
    def accept_legacy_enable_thinking(cls, value: Any) -> Any:
        if not isinstance(value, dict) or "enable_thinking" not in value:
            return value
        copied = dict(value)
        legacy_value = copied.pop("enable_thinking")
        if "think" in copied and copied["think"] != legacy_value:
            raise ValueError("think and enable_thinking must match when both are provided")
        copied.setdefault("think", legacy_value)
        return copied


class LlmRequest(GenerationRequest):
    system_prompt: str
    prompt: str

    @field_validator("system_prompt", "prompt")
    @classmethod
    def reject_surrogates(cls, value: str) -> str:
        if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
            raise ValueError("LLM text contains invalid Unicode surrogate characters")
        return value


class LlmResponse(BaseModel):
    model: str
    answer: str


class ChatResponse(LlmResponse):
    context_window: int
    prompt_tokens: int
    max_response_tokens: int
    remaining_tokens: int
    cache_enabled: bool


class ChatRequest(GenerationRequest):
    system_prompt: str | None = None
    prompt: str
    reference_context: str | None = None

    @field_validator("system_prompt", "prompt", "reference_context")
    @classmethod
    def reject_surrogates(cls, value: str | None) -> str | None:
        if value is not None and any(0xD800 <= ord(char) <= 0xDFFF for char in value):
            raise ValueError("LLM text contains invalid Unicode surrogate characters")
        return value

    @field_validator("reference_context")
    @classmethod
    def limit_reference_context_size(cls, value: str | None) -> str | None:
        if value is not None and len(value.encode("utf-8")) > REFERENCE_CONTEXT_MAX_BYTES:
            raise ValueError(
                f"reference_context exceeds {REFERENCE_CONTEXT_MAX_BYTES} UTF-8 bytes"
            )
        return value
