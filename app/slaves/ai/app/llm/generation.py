from __future__ import annotations

import json
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator, Literal

from app.logging import log

ThinkingEffort = Literal["default", "low"]
ResponseFormat = Literal["text", "json"]

LOW_THINKING_INSTRUCTION = (
    "Use concise and efficient internal reasoning. Do not explore alternatives unless necessary. "
    "Stop reasoning as soon as you have enough information to produce the final answer."
)
GEMMA_THOUGHT_START = "<|channel>thought"
GEMMA_THOUGHT_END = "<channel|>"
QWEN_THOUGHT_START = "<think>"
QWEN_THOUGHT_END = "</think>"
TURN_END = "<turn|>"


@dataclass(frozen=True)
class GenerationOutput:
    answer: str
    pending_delta: str
    reasoning_format: str
    reasoning_chars: int
    json_recovered: bool


def resolve_thinking(default: bool, requested: bool | None) -> bool:
    return default if requested is None else requested


def apply_thinking_effort(
    messages: list[dict[str, str]],
    enable_thinking: bool,
    thinking_effort: ThinkingEffort,
) -> list[dict[str, str]]:
    copied_messages = [dict(message) for message in messages]
    if not enable_thinking or thinking_effort != "low":
        return copied_messages
    for message in copied_messages:
        if message.get("role") == "system":
            message["content"] = f"{message.get('content', '').rstrip()}\n\n{LOW_THINKING_INSTRUCTION}"
            break
    return copied_messages


@contextmanager
def thinking_override(llm: Any, requested: bool | None) -> Iterator[None]:
    had_previous_override = hasattr(llm, "_ai_slave_enable_thinking_override")
    previous_override = getattr(llm, "_ai_slave_enable_thinking_override", None)
    if requested is not None:
        setattr(llm, "_ai_slave_enable_thinking_override", requested)
    try:
        yield
    finally:
        if had_previous_override:
            setattr(llm, "_ai_slave_enable_thinking_override", previous_override)
        elif hasattr(llm, "_ai_slave_enable_thinking_override"):
            delattr(llm, "_ai_slave_enable_thinking_override")


class GenerationOutputParser:
    def __init__(
        self,
        *,
        expect_reasoning: bool,
        response_format: ResponseFormat,
    ) -> None:
        self.expect_reasoning = expect_reasoning
        self.response_format = response_format
        self.reasoning_format = "none"
        self.reasoning_chars = 0
        self._state = "detecting" if expect_reasoning else "final"
        self._reasoning_buffer = ""
        self._final_text = ""
        self._held_final = ""
        self._emitted_final = ""
        self._final_started = False

    def feed(self, delta: str) -> str:
        if not delta:
            return ""
        if self._state == "final":
            return self._accept_final(delta)

        self._reasoning_buffer += delta
        gemma_start = self._reasoning_buffer.find(GEMMA_THOUGHT_START)
        if gemma_start >= 0:
            gemma_end = self._reasoning_buffer.find(
                GEMMA_THOUGHT_END,
                gemma_start + len(GEMMA_THOUGHT_START),
            )
            if gemma_end < 0:
                self._state = "gemma"
                return ""
            reasoning_start = gemma_start + len(GEMMA_THOUGHT_START)
            self.reasoning_chars = len(self._reasoning_buffer[reasoning_start:gemma_end].strip())
            final = self._reasoning_buffer[gemma_end + len(GEMMA_THOUGHT_END):]
            self._reasoning_buffer = ""
            self._state = "final"
            self.reasoning_format = "gemma"
            return self._accept_final(final)

        qwen_end = self._reasoning_buffer.rfind(QWEN_THOUGHT_END)
        if qwen_end >= 0:
            qwen_start = self._reasoning_buffer.find(QWEN_THOUGHT_START)
            reasoning_start = qwen_start + len(QWEN_THOUGHT_START) if 0 <= qwen_start < qwen_end else 0
            self.reasoning_chars = len(self._reasoning_buffer[reasoning_start:qwen_end].strip())
            final = self._reasoning_buffer[qwen_end + len(QWEN_THOUGHT_END):]
            self._reasoning_buffer = ""
            self._state = "final"
            self.reasoning_format = "qwen"
            return self._accept_final(final)

        if GEMMA_THOUGHT_START in self._reasoning_buffer:
            self._state = "gemma"
        elif QWEN_THOUGHT_START in self._reasoning_buffer:
            self._state = "qwen"
        return ""

    def finish(self, model_name: str) -> GenerationOutput:
        finish_emitted = ""
        if self._state == "gemma":
            raise RuntimeError("LLM returned an unterminated Gemma thought channel")
        if self._state == "qwen":
            raise RuntimeError("LLM returned an unterminated Qwen think block")
        if self._state == "detecting":
            self._state = "final"
            finish_emitted = self._accept_final(self._reasoning_buffer)
            self._reasoning_buffer = ""

        answer = self._final_text.strip()
        if answer.endswith(TURN_END):
            answer = answer[:-len(TURN_END)].rstrip()
        if not answer:
            raise RuntimeError("LLM returned no final answer after reasoning")

        json_recovered = False
        if self.response_format == "json":
            try:
                json_payload = json.loads(answer)
            except json.JSONDecodeError:
                decoder = json.JSONDecoder()
                candidates: list[tuple[int, int, dict[str, Any]]] = []
                for start_index, character in enumerate(answer):
                    if character != "{":
                        continue
                    try:
                        candidate, relative_end = decoder.raw_decode(answer[start_index:])
                    except json.JSONDecodeError:
                        continue
                    if isinstance(candidate, dict):
                        candidates.append((start_index, start_index + relative_end, candidate))
                maximal_candidates = [
                    candidate
                    for candidate in candidates
                    if not any(
                        other_start <= candidate[0]
                        and candidate[1] <= other_end
                        and (other_start, other_end) != (candidate[0], candidate[1])
                        for other_start, other_end, _ in candidates
                    )
                ]
                if len(maximal_candidates) != 1:
                    raise RuntimeError("LLM final answer does not contain exactly one JSON object")
                json_payload = maximal_candidates[0][2]
                json_recovered = True
            if not isinstance(json_payload, dict):
                raise RuntimeError("LLM final answer must be a JSON object")
            answer = json.dumps(json_payload, ensure_ascii=False, separators=(",", ":"))

        pending_delta = (
            answer
            if self.response_format == "json"
            else finish_emitted + answer[len(self._emitted_final):]
        )
        log(
            "LLM output parsed "
            f"model={model_name} "
            f"reasoning_format={self.reasoning_format} "
            f"reasoning_chars={self.reasoning_chars} "
            f"final_chars={len(answer)} "
            f"json_recovered={json_recovered}"
        )
        return GenerationOutput(
            answer=answer,
            pending_delta=pending_delta,
            reasoning_format=self.reasoning_format,
            reasoning_chars=self.reasoning_chars,
            json_recovered=json_recovered,
        )

    def _accept_final(self, text: str) -> str:
        if not text:
            return ""
        if not self._final_started:
            text = text.lstrip()
            self._final_started = bool(text)
        self._final_text += text
        if self.response_format == "json":
            return ""
        self._held_final += text
        if len(self._held_final) <= len(TURN_END):
            return ""
        emitted = self._held_final[:-len(TURN_END)]
        self._held_final = self._held_final[-len(TURN_END):]
        self._emitted_final += emitted
        return emitted
