from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from models import ExperimentSourceBundle


ReasoningEffort = Literal["none", "low", "medium", "high", "xhigh", "max"]


class AgentMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=32_000)


class AgentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(min_length=1, max_length=32_000)
    messages: list[AgentMessage] = Field(default_factory=list, max_length=6)

    @model_validator(mode="after")
    def validate_total_size(self) -> "AgentRequest":
        total = len(self.prompt.encode("utf-8")) + sum(
            len(message.content.encode("utf-8")) for message in self.messages
        )
        if total > 64 * 1024:
            raise ValueError("Agent conversation exceeds 64 KiB")
        return self


class ExperimentSourceDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["experiment"]
    formatVersion: Literal[2]
    apiVersion: Literal[7, 8, 9]
    sourceBundle: ExperimentSourceBundle


class AgentWorkspace(BaseModel):
    model_config = ConfigDict(extra="forbid")

    experimentId: int | None = Field(default=None, gt=0)
    document: ExperimentSourceDocument
    baseHash: str = Field(pattern=r"^[0-9a-f]{64}$")
    experimentContextVersion: str = Field(min_length=1, max_length=256)
    workspaceSession: int = Field(ge=0)
    activeFile: str | None = Field(default=None, max_length=256)

    @model_validator(mode="after")
    def validate_active_file(self) -> "AgentWorkspace":
        if self.activeFile is not None and self.activeFile not in self.document.sourceBundle.files:
            raise ValueError("activeFile must name a sourceBundle file")
        return self


class RunStart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["run.start"]
    request: AgentRequest
    provider: Literal["openai"]
    model: Literal["gpt-5.6-luna"]
    reasoningEffort: ReasoningEffort = "medium"
    workspace: AgentWorkspace
    sessionContextEnvelope: str | None = Field(default=None, max_length=2 * 1024 * 1024)


class RunCancel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["run.cancel"]
    runId: str = Field(min_length=1, max_length=128)


ClientMessage = RunStart | RunCancel


def parse_client_message(value: Any) -> ClientMessage:
    if not isinstance(value, dict):
        raise ValueError("WebSocket message must be an object")
    message_type = value.get("type")
    if message_type == "run.start":
        return RunStart.model_validate(value)
    if message_type == "run.cancel":
        return RunCancel.model_validate(value)
    raise ValueError("Unsupported WebSocket message type")
