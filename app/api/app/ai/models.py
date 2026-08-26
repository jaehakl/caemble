from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from models import ExperimentSourceBundle


ReasoningEffort = str


class AgentMessage(BaseModel):
    role: str
    content: str


class AgentRequest(BaseModel):
    prompt: str
    messages: list[AgentMessage] = Field(default_factory=list)


class ExperimentSourceDocument(BaseModel):
    kind: str
    sourceBundle: ExperimentSourceBundle


class AgentWorkspace(BaseModel):
    experimentId: int | None = None
    document: ExperimentSourceDocument
    baseHash: str
    workspaceSession: int
    activeFile: str | None = None


class RunStart(BaseModel):
    type: str
    request: AgentRequest
    provider: str
    model: str
    reasoningEffort: ReasoningEffort = "medium"
    workspace: AgentWorkspace
    sessionContextEnvelope: str | None = None


class RunCancel(BaseModel):
    type: str
    runId: str


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
