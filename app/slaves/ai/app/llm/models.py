from __future__ import annotations

from pydantic import BaseModel

from app.llm.generation import ResponseFormat, ThinkingEffort



class GenerationRequest(BaseModel):
    model: str | None = None
    max_tokens: int | None = None
    temperature: float | None = None
    context_size: int | None = None
    top_p: float | None = None
    think: bool | None = None
    thinking_effort: ThinkingEffort = "default"
    response_format: ResponseFormat = "text"

class LlmRequest(GenerationRequest):
    system_prompt: str
    prompt: str

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
