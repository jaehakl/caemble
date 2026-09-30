from __future__ import annotations

from typing import Any, Literal, Union

from pydantic import BaseModel, Field, model_validator

from sdk.protocol.execution import ExecutionIdentity, ResourceAllocation, ResourceRequest


class SignalPayload(BaseModel):
    type: Literal["offer", "answer", "ice", "end-of-candidates"]
    sdp: str | None = None
    candidate: str | None = None
    sdpMid: str | None = None
    sdpMLineIndex: int | None = None


class LauncherHello(BaseModel):
    type: Literal["launcher.hello"]
    execution_protocol: Literal[2]
    installation_id: str = Field(min_length=1)
    boot_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    launcher_name: str
    slave_app_ids: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    job_modes: dict[str, Literal["webrtc", "websocket"]] = Field(default_factory=dict)
    storage_versions: dict[str, Literal[1]] = Field(default_factory=dict)
    instances: list[dict[str, Any]] = Field(default_factory=list)
    resources: dict[str, Any] = Field(default_factory=dict)
    cleanup_receipts: list[dict[str, Any]] = Field(default_factory=list)


class LauncherHeartbeat(BaseModel):
    type: Literal["launcher.heartbeat"]
    boot_id: str
    session_id: str
    status: Literal["ready", "busy", "recovering"] = "ready"
    instances: list[dict[str, Any]] = Field(default_factory=list)
    resources: dict[str, Any] = Field(default_factory=dict)
    cleanup_receipts: list[dict[str, Any]] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class LauncherAccepted(BaseModel):
    type: Literal["launcher.accepted"]
    execution_protocol: Literal[2] = 2
    launcher_id: str
    boot_id: str
    session_id: str
    server_time: str
    capabilities: dict[str, Any] = Field(default_factory=dict)
    instances: list[dict[str, Any]] = Field(default_factory=list)


class ExecutionMessage(ExecutionIdentity):
    # Local worker stdio has no control connection. The supervisor adds the
    # current session when forwarding an event to the API.
    session_id: str | None = None


class JobReserve(ExecutionMessage):
    type: Literal["job.reserve"]
    handler_type: str
    slave_app_id: str
    job_mode: Literal["webrtc", "websocket"] = "webrtc"
    resources: ResourceRequest = Field(default_factory=ResourceRequest)


class JobReserved(ExecutionMessage):
    type: Literal["job.reserved"]
    allocation: ResourceAllocation


class JobRejected(ExecutionMessage):
    type: Literal["job.rejected"]
    reason: str
    resource_revision: int = Field(ge=0)


class JobStart(ExecutionMessage):
    type: Literal["job.start"]
    handler_type: str
    slave_app_id: str
    job_mode: Literal["webrtc", "websocket"] = "webrtc"
    allocation: ResourceAllocation
    offer: SignalPayload | None = None
    websocket_url: str | None = None
    token: str | None = None

    @model_validator(mode="after")
    def require_connection(self):
        if self.job_mode == "webrtc" and self.offer is None:
            raise ValueError("WebRTC jobs require an offer")
        if self.job_mode == "websocket" and (not self.websocket_url or not self.token):
            raise ValueError("WebSocket jobs require a URL and token")
        return self


class JobCancel(ExecutionMessage):
    type: Literal["job.cancel"]
    reason: str = "cancelled"


class WorkerReset(ExecutionMessage):
    type: Literal["worker.reset"]
    reason: str = "reset requested"


class LauncherStopAll(BaseModel):
    type: Literal["launcher.stop_all"]
    boot_id: str
    session_id: str
    reason: str = "launcher shutdown requested"


class ControlError(BaseModel):
    type: Literal["error"]
    detail: str


class JobAnswer(ExecutionMessage):
    type: Literal["job.answer"]
    answer: SignalPayload


class JobRunning(ExecutionMessage):
    type: Literal["job.running"]


class JobProgress(ExecutionMessage):
    type: Literal["job.progress"]
    progress: Any = None


class JobResult(ExecutionMessage):
    type: Literal["job.result"]


class JobError(ExecutionMessage):
    type: Literal["job.error"]
    code: str = "job_error"
    detail: str


class JobCancelled(ExecutionMessage):
    type: Literal["job.cancelled"]
    reason: str = "cancelled"


class JobCleaned(ExecutionMessage):
    type: Literal["job.cleaned"]


class JobCleanedAck(ExecutionMessage):
    type: Literal["job.cleaned.ack"]


class WorkerResetDone(ExecutionMessage):
    type: Literal["worker.reset.done"]


LauncherToServerMessage = Union[
    LauncherHello, LauncherHeartbeat, JobReserved, JobRejected, JobAnswer,
    JobRunning, JobProgress, JobResult, JobError, JobCancelled, JobCleaned,
    WorkerResetDone,
]
ServerToLauncherMessage = Union[
    LauncherAccepted, JobReserve, JobStart, JobCancel, JobCleanedAck,
    WorkerReset, LauncherStopAll, ControlError,
]

_LAUNCHER_TO_SERVER = {
    "launcher.hello": LauncherHello,
    "launcher.heartbeat": LauncherHeartbeat,
    "job.reserved": JobReserved,
    "job.rejected": JobRejected,
    "job.answer": JobAnswer,
    "job.running": JobRunning,
    "job.progress": JobProgress,
    "job.result": JobResult,
    "job.error": JobError,
    "job.cancelled": JobCancelled,
    "job.cleaned": JobCleaned,
    "worker.reset.done": WorkerResetDone,
}
_SERVER_TO_LAUNCHER = {
    "launcher.accepted": LauncherAccepted,
    "job.reserve": JobReserve,
    "job.start": JobStart,
    "job.cancel": JobCancel,
    "job.cleaned.ack": JobCleanedAck,
    "worker.reset": WorkerReset,
    "launcher.stop_all": LauncherStopAll,
    "error": ControlError,
}


def parse_launcher_message(value: Any) -> LauncherToServerMessage:
    return _LAUNCHER_TO_SERVER[value["type"]].model_validate(value)


def parse_server_message(value: Any) -> ServerToLauncherMessage:
    return _SERVER_TO_LAUNCHER[value["type"]].model_validate(value)


class DataChannelAttachment(BaseModel):
    id: str
    name: str | None = None
    mimeType: str | None = None
    size: int | None = None
    data: bytes = b""


class DataChannelMessage(BaseModel):
    id: str
    type: str
    payload: Any = None
    attachments: list[DataChannelAttachment] = Field(default_factory=list)
