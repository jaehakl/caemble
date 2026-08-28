from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, model_validator

from models import ExperimentSourceBundle


ReasoningEffort = str
AGENT_WORKSPACE_SCHEMA_VERSION = "caemble-ai-agent-v5-calculation-source"


class AgentMessage(BaseModel):
    role: str
    content: str


class AgentRequest(BaseModel):
    prompt: str
    messages: list[AgentMessage] = Field(default_factory=list)


class ExperimentSourceDocument(BaseModel):
    kind: Literal["experiment"]
    sourceBundle: ExperimentSourceBundle


class CalculationSourceDocument(BaseModel):
    kind: Literal["calculation"]
    calculationId: int | None = None
    experimentId: int
    name: str
    description: str
    sourceCode: str
    editable: bool
    context: dict[str, Any] = Field(default_factory=dict)
    referenceExperiment: ExperimentSourceDocument

    @model_validator(mode="after")
    def validate_context_size(self) -> "CalculationSourceDocument":
        encoded = json.dumps(
            self.context,
            ensure_ascii=False,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
        if len(encoded) > 32 * 1024:
            raise ValueError("Calculation context exceeds 32 KiB")
        return self


AgentSourceDocument = Annotated[
    ExperimentSourceDocument | CalculationSourceDocument,
    Field(discriminator="kind"),
]


class AgentWorkspace(BaseModel):
    schemaVersion: Literal[AGENT_WORKSPACE_SCHEMA_VERSION]
    experimentId: int | None = None
    document: AgentSourceDocument
    baseHash: str
    referenceHash: str | None = None
    workspaceSession: int
    activeFile: str | None = None

    @model_validator(mode="after")
    def validate_document_identity(self) -> "AgentWorkspace":
        if self.document.kind == "calculation":
            if self.experimentId != self.document.experimentId:
                raise ValueError("Calculation document Experiment does not match workspace")
            if self.referenceHash is None:
                raise ValueError("Calculation workspace requires referenceHash")
        return self


class RunStart(BaseModel):
    type: str
    request: AgentRequest
    provider: str
    model: str
    reasoningEffort: ReasoningEffort = "none"
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
