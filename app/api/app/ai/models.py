from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from models import ExperimentSourceBundle
from ai.workspace import validate_geometry_snapshot


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
    apiVersion: Literal[7]
    sourceBundle: ExperimentSourceBundle


class AgentWorkspaceValidation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["valid", "invalid", "unavailable", "stale"] = "unavailable"
    revision: int = Field(default=0, ge=0)
    diagnostics: list[dict[str, Any] | str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validate_diagnostic_sizes(self) -> "AgentWorkspaceValidation":
        for diagnostic in self.diagnostics:
            encoded = json.dumps(
                diagnostic,
                ensure_ascii=False,
                separators=(",", ":"),
                default=str,
            ).encode("utf-8")
            if len(encoded) > 1024:
                raise ValueError("Workspace validation diagnostic exceeds 1 KiB")
        return self


class AgentWorkspace(BaseModel):
    model_config = ConfigDict(extra="forbid")

    experimentId: int | None = Field(default=None, gt=0)
    document: ExperimentSourceDocument
    baseHash: str = Field(pattern=r"^[0-9a-f]{64}$")
    geometryContextVersion: str = Field(min_length=1, max_length=256)
    workspaceSession: int = Field(ge=0)
    activeFile: str | None = Field(default=None, max_length=256)
    validation: AgentWorkspaceValidation = Field(default_factory=AgentWorkspaceValidation)

    @model_validator(mode="after")
    def validate_active_file(self) -> "AgentWorkspace":
        if self.activeFile is not None and self.activeFile not in self.document.sourceBundle.files:
            raise ValueError("activeFile must name a sourceBundle file")
        validate_geometry_snapshot(self.document.sourceBundle.geometrySnapshot)
        return self


class RunStart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["run.start"]
    request: AgentRequest
    provider: Literal["openai"]
    model: Literal["gpt-5.6-luna"]
    reasoningEffort: ReasoningEffort = "high"
    workspace: AgentWorkspace
    sessionContextEnvelope: str | None = Field(default=None, max_length=2 * 1024 * 1024)


class ClientToolResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["client_tool.result"]
    runId: str = Field(min_length=1, max_length=128)
    callId: str = Field(min_length=1, max_length=128)
    stagedRevision: int = Field(ge=0)
    sourceHash: str = Field(pattern=r"^[0-9a-f]{64}$")
    status: Literal["valid", "invalid", "unavailable"]
    result: dict[str, Any]

    @model_validator(mode="after")
    def validate_result_size(self) -> "ClientToolResult":
        encoded = json.dumps(
            self.result,
            ensure_ascii=False,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
        if len(encoded) > 64 * 1024:
            raise ValueError("Client tool result exceeds 64 KiB")
        allowed_keys = {
            "status",
            "stagedRevision",
            "contextVersion",
            "requestedSourceHash",
            "sourceHash",
            "catalogFingerprint",
            "varsSchemaFingerprint",
            "sceneHash",
            "taskSceneHashes",
            "diagnostics",
            "error",
            "message",
        }
        if not set(self.result).issubset(allowed_keys):
            raise ValueError("Client tool result contains unsupported fields")
        result_status = self.result.get("status")
        if result_status is not None and result_status not in {"valid", "invalid", "unavailable"}:
            raise ValueError("Client tool result status is invalid")
        revision = self.result.get("stagedRevision")
        if revision is not None and (
            isinstance(revision, bool) or not isinstance(revision, int) or revision < 0
        ):
            raise ValueError("Client tool result revision is invalid")
        for key in ("contextVersion", "catalogFingerprint"):
            value = self.result.get(key)
            if value is not None and (
                not isinstance(value, str) or not value or len(value) > 256
            ):
                raise ValueError(f"Client tool result {key} is invalid")
        for key in (
            "requestedSourceHash",
            "sourceHash",
            "varsSchemaFingerprint",
            "sceneHash",
        ):
            value = self.result.get(key)
            if value is not None and (
                not isinstance(value, str)
                or len(value) != 64
                or any(character not in "0123456789abcdef" for character in value)
            ):
                raise ValueError(f"Client tool result {key} is invalid")
        task_hashes = self.result.get("taskSceneHashes")
        if task_hashes is not None and (
            not isinstance(task_hashes, dict)
            or len(task_hashes) > 64
            or any(
                not isinstance(name, str) or not name or len(name) > 256
                for name in task_hashes
            )
            or any(
                not isinstance(value, str)
                or len(value) != 64
                or any(character not in "0123456789abcdef" for character in value)
                for value in task_hashes.values()
            )
        ):
            raise ValueError("Client tool result task scene hashes are invalid")
        diagnostics = self.result.get("diagnostics")
        if diagnostics is not None:
            if not isinstance(diagnostics, list) or len(diagnostics) > 20:
                raise ValueError("Client tool result diagnostics are invalid")
            for diagnostic in diagnostics:
                if not isinstance(diagnostic, dict) or set(diagnostic) != {
                    "file",
                    "range",
                    "code",
                    "severity",
                    "phase",
                    "message",
                }:
                    raise ValueError("Client tool result diagnostic is invalid")
                range_value = diagnostic.get("range")
                if (
                    not isinstance(diagnostic.get("file"), str)
                    or not diagnostic["file"]
                    or len(diagnostic["file"]) > 256
                    or not isinstance(diagnostic.get("message"), str)
                    or len(diagnostic["message"]) > 1_000
                    or diagnostic.get("severity") not in {"error", "warning", "info"}
                    or diagnostic.get("phase")
                    not in {"syntax", "semantic", "policy", "runtime", "model"}
                    or isinstance(diagnostic.get("code"), bool)
                    or not isinstance(diagnostic.get("code"), (int, str))
                    or not isinstance(range_value, dict)
                    or set(range_value)
                    != {
                        "startLineNumber",
                        "startColumn",
                        "endLineNumber",
                        "endColumn",
                    }
                    or any(
                        isinstance(value, bool) or not isinstance(value, int) or value < 1
                        for value in range_value.values()
                    )
                ):
                    raise ValueError("Client tool result diagnostic is invalid")
        error = self.result.get("error")
        if error is not None and (
            not isinstance(error, dict)
            or set(error) != {"kind", "message"}
            or error.get("kind")
            not in {
                "structural",
                "catalog",
                "policy",
                "type",
                "evaluation",
                "python",
                "timeout",
                "cancelled",
            }
            or not isinstance(error.get("message"), str)
            or not error["message"]
            or len(error["message"]) > 4_000
        ):
            raise ValueError("Client tool result error is invalid")
        message = self.result.get("message")
        if message is not None and (
            not isinstance(message, str) or not message or len(message) > 4_000
        ):
            raise ValueError("Client tool result message is invalid")
        if self.status == "valid":
            required_attestation = {
                "status",
                "stagedRevision",
                "contextVersion",
                "requestedSourceHash",
                "sourceHash",
                "catalogFingerprint",
                "varsSchemaFingerprint",
                "sceneHash",
                "taskSceneHashes",
                "diagnostics",
                "error",
            }
            if not required_attestation.issubset(self.result):
                raise ValueError("Valid client tool result attestation is incomplete")
            if self.result.get("status") != "valid":
                raise ValueError("Valid client tool result status does not match")
            if self.result.get("stagedRevision") != self.stagedRevision:
                raise ValueError("Valid client tool result revision does not match")
            if self.result.get("requestedSourceHash") != self.sourceHash:
                raise ValueError("Valid client tool result requested source hash does not match")
            if self.result.get("sourceHash") != self.sourceHash:
                raise ValueError("Valid client tool result source hash does not match")
            context_version = self.result.get("contextVersion")
            if not isinstance(context_version, str) or not context_version or len(context_version) > 256:
                raise ValueError("Valid client tool result context version is invalid")
            catalog_fingerprint = self.result.get("catalogFingerprint")
            if (
                not isinstance(catalog_fingerprint, str)
                or not catalog_fingerprint
                or len(catalog_fingerprint) > 256
            ):
                raise ValueError("Valid client tool result catalog fingerprint is invalid")
            for key in ("varsSchemaFingerprint", "sceneHash"):
                value = self.result.get(key)
                if (
                    not isinstance(value, str)
                    or len(value) != 64
                    or any(character not in "0123456789abcdef" for character in value)
                ):
                    raise ValueError(f"Valid client tool result {key} is invalid")
            task_hashes = self.result.get("taskSceneHashes")
            if (
                not isinstance(task_hashes, dict)
                or len(task_hashes) > 64
                or any(not isinstance(name, str) or not name or len(name) > 256 for name in task_hashes)
                or any(
                    not isinstance(value, str)
                    or len(value) != 64
                    or any(character not in "0123456789abcdef" for character in value)
                    for value in task_hashes.values()
                )
            ):
                raise ValueError("Valid client tool result task scene hashes are invalid")
            diagnostics = self.result.get("diagnostics")
            if not isinstance(diagnostics, list) or len(diagnostics) > 20 or self.result.get("error") is not None:
                raise ValueError("Valid client tool result diagnostics are invalid")
        return self


class RunCancel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["run.cancel"]
    runId: str = Field(min_length=1, max_length=128)


ClientMessage = RunStart | ClientToolResult | RunCancel


def parse_client_message(value: Any) -> ClientMessage:
    if not isinstance(value, dict):
        raise ValueError("WebSocket message must be an object")
    message_type = value.get("type")
    if message_type == "run.start":
        return RunStart.model_validate(value)
    if message_type == "client_tool.result":
        return ClientToolResult.model_validate(value)
    if message_type == "run.cancel":
        return RunCancel.model_validate(value)
    raise ValueError("Unsupported WebSocket message type")
