from __future__ import annotations

from typing import Any, Literal, Union

from pydantic import BaseModel, Field


class SignalPayload(BaseModel):
    type: Literal["offer", "answer", "ice", "end-of-candidates"]
    sdp: str | None = None
    candidate: str | None = None
    sdpMid: str | None = None
    sdpMLineIndex: int | None = None


class LauncherHello(BaseModel):
    type: Literal["launcher.hello"]
    launcher_name: str
    slave_app_ids: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class LauncherHeartbeat(BaseModel):
    type: Literal["launcher.heartbeat"]
    status: Literal["ready", "busy"] = "ready"
    current_job_id: str | None = None
    loaded_slave_app_id: str | None = None
    worker_status: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)



class LauncherAccepted(BaseModel):
    type: Literal["launcher.accepted"]
    launcher_id: str
    server_time: str
    capabilities: dict[str, Any] = Field(default_factory=dict)


class JobStart(BaseModel):
    type: Literal["job.start"]
    job_id: str
    handler_type: str
    slave_app_id: str
    offer: SignalPayload


class JobCancel(BaseModel):
    type: Literal["job.cancel"]
    job_id: str
    reason: str = "cancelled"


class WorkerReset(BaseModel):
    type: Literal["worker.reset"]
    reason: str = "reset requested"


class ControlError(BaseModel):
    type: Literal["error"]
    detail: str


class JobAnswer(BaseModel):
    type: Literal["job.answer"]
    job_id: str
    answer: SignalPayload


class JobRunning(BaseModel):
    type: Literal["job.running"]
    job_id: str


class JobProgress(BaseModel):
    type: Literal["job.progress"]
    job_id: str
    progress: Any = None


class JobResult(BaseModel):
    type: Literal["job.result"]
    job_id: str


class JobError(BaseModel):
    type: Literal["job.error"]
    job_id: str
    code: str = "job_error"
    detail: str


class JobCancelled(BaseModel):
    type: Literal["job.cancelled"]
    job_id: str
    reason: str = "cancelled"


class WorkerResetDone(BaseModel):
    type: Literal["worker.reset.done"]


LauncherToServerMessage = Union[
        LauncherHello,
        LauncherHeartbeat,
        JobAnswer,
        JobRunning,
        JobProgress,
        JobResult,
        JobError,
        JobCancelled,
        WorkerResetDone,
    ]

ServerToLauncherMessage = Union[
        LauncherAccepted,
        JobStart,
        JobCancel,
        WorkerReset,
        ControlError,
    ]

_LAUNCHER_TO_SERVER = {
    "launcher.hello": LauncherHello,
    "launcher.heartbeat": LauncherHeartbeat,
    "job.answer": JobAnswer,
    "job.running": JobRunning,
    "job.progress": JobProgress,
    "job.result": JobResult,
    "job.error": JobError,
    "job.cancelled": JobCancelled,
    "worker.reset.done": WorkerResetDone,
}
_SERVER_TO_LAUNCHER = {
    "launcher.accepted": LauncherAccepted,
    "job.start": JobStart,
    "job.cancel": JobCancel,
    "worker.reset": WorkerReset,
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
