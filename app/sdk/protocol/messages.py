from __future__ import annotations

import json
from typing import Any, Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SignalPayload(StrictModel):
    type: Literal["offer", "answer", "ice", "end-of-candidates"]
    sdp: str | None = Field(default=None, max_length=256 * 1024)
    candidate: str | None = Field(default=None, max_length=16 * 1024)
    sdpMid: str | None = Field(default=None, max_length=256)
    sdpMLineIndex: int | None = None


class LauncherHello(StrictModel):
    type: Literal["launcher.hello"]
    launcher_name: str = Field(min_length=1, max_length=128)
    slave_app_ids: list[str] = Field(default_factory=list, max_length=64)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_hello_size(self) -> "LauncherHello":
        if any(len(item) > 128 for item in self.slave_app_ids):
            raise ValueError("slave_app_id exceeds 128 characters")
        if len(json.dumps(self.metadata, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 64 * 1024:
            raise ValueError("launcher metadata exceeds 65536 bytes")
        return self


class LauncherHeartbeat(StrictModel):
    type: Literal["launcher.heartbeat"]
    status: Literal["ready", "busy"] = "ready"
    current_job_id: str | None = None
    loaded_slave_app_id: str | None = None
    worker_status: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_metadata_size(self) -> "LauncherHeartbeat":
        if len(json.dumps(self.metadata, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 64 * 1024:
            raise ValueError("launcher metadata exceeds 65536 bytes")
        return self


class LauncherAccepted(StrictModel):
    type: Literal["launcher.accepted"]
    launcher_id: str
    server_time: str
    capabilities: dict[str, Any] = Field(default_factory=dict)


class JobStart(StrictModel):
    type: Literal["job.start"]
    job_id: str
    handler_type: str
    slave_app_id: str
    offer: SignalPayload


class JobCancel(StrictModel):
    type: Literal["job.cancel"]
    job_id: str
    reason: str = Field(default="cancelled", max_length=4096)


class WorkerReset(StrictModel):
    type: Literal["worker.reset"]
    reason: str = Field(default="reset requested", max_length=4096)


class ControlError(StrictModel):
    type: Literal["error"]
    detail: str = Field(max_length=16 * 1024)


class JobAnswer(StrictModel):
    type: Literal["job.answer"]
    job_id: str
    answer: SignalPayload


class JobRunning(StrictModel):
    type: Literal["job.running"]
    job_id: str


class JobProgress(StrictModel):
    type: Literal["job.progress"]
    job_id: str
    progress: Any = None


class JobResult(StrictModel):
    type: Literal["job.result"]
    job_id: str


class JobError(StrictModel):
    type: Literal["job.error"]
    job_id: str
    code: str = Field(default="job_error", max_length=128)
    detail: str = Field(max_length=16 * 1024)


class JobCancelled(StrictModel):
    type: Literal["job.cancelled"]
    job_id: str
    reason: str = Field(default="cancelled", max_length=4096)


class WorkerResetDone(StrictModel):
    type: Literal["worker.reset.done"]


LauncherToServerMessage = Annotated[
    Union[
        LauncherHello,
        LauncherHeartbeat,
        JobAnswer,
        JobRunning,
        JobProgress,
        JobResult,
        JobError,
        JobCancelled,
        WorkerResetDone,
    ],
    Field(discriminator="type"),
]

ServerToLauncherMessage = Annotated[
    Union[
        LauncherAccepted,
        JobStart,
        JobCancel,
        WorkerReset,
        ControlError,
    ],
    Field(discriminator="type"),
]

_launcher_to_server_adapter = TypeAdapter(LauncherToServerMessage)
_server_to_launcher_adapter = TypeAdapter(ServerToLauncherMessage)


def parse_launcher_message(value: Any) -> LauncherToServerMessage:
    return _launcher_to_server_adapter.validate_python(value)


def parse_server_message(value: Any) -> ServerToLauncherMessage:
    return _server_to_launcher_adapter.validate_python(value)


class DataChannelAttachment(StrictModel):
    id: str
    name: str | None = None
    mimeType: str | None = None
    size: int | None = Field(default=None, ge=0)
    data: bytes = b""

    @model_validator(mode="after")
    def fill_size(self) -> "DataChannelAttachment":
        if self.size is None:
            self.size = len(self.data)
        return self


class DataChannelMessage(StrictModel):
    id: str
    type: str
    payload: Any = None
    attachments: list[DataChannelAttachment] = Field(default_factory=list)
