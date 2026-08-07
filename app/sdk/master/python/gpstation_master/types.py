from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Generic, TypeVar

if TYPE_CHECKING:
    from .client import GpStationJobSession


TResult = TypeVar("TResult")


@dataclass(slots=True)
class SignalPayload:
    type: str
    sdp: str | None = None
    candidate: str | None = None
    sdp_mid: str | None = None
    sdp_mline_index: int | None = None


@dataclass(slots=True)
class LauncherView:
    id: str
    user_id: str
    launcher_name: str
    status: str
    slave_app_ids: list[str]
    connected_at: str
    last_heartbeat_at: str
    ip_address: str | None = None
    disconnected_at: str | None = None


@dataclass(slots=True)
class JobDescriptor:
    id: str
    user_id: str
    handler_type: str
    slave_app_id: str
    offer: SignalPayload
    progress: list[Any]
    state: str
    answer: SignalPayload | None = None
    launcher_id: str | None = None
    assigned_at: str | None = None
    answer_ready_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    cancel_requested_at: str | None = None
    last_error: str | None = None
    attempt_count: int = 0
    created_at: str | None = None
    updated_at: str | None = None


@dataclass(slots=True)
class JobCreateResult:
    job: JobDescriptor
    answer_wait_url: str


@dataclass(slots=True)
class JobAnswerWaitResult:
    job_id: str
    state: str
    answer: SignalPayload | None = None
    last_error: str | None = None


@dataclass(slots=True)
class AttachmentMetadata:
    id: str
    size: int
    name: str | None = None
    mime_type: str | None = None


@dataclass(slots=True)
class RequestAttachment:
    id: str
    data: bytes
    name: str | None = None
    mime_type: str | None = None


@dataclass(slots=True)
class ReceivedFile:
    id: str
    data: bytes
    size: int
    name: str | None = None
    mime_type: str | None = None


@dataclass(slots=True)
class AttachmentChunkHeader:
    kind: str
    call_id: str
    attachment_id: str
    index: int
    final: bool


@dataclass(slots=True)
class CallResult(Generic[TResult]):
    payload: TResult
    files: list[ReceivedFile]


@dataclass(slots=True)
class RunJobSessionResult(Generic[TResult]):
    payload: TResult
    files: list[ReceivedFile]
    session: GpStationJobSession


@dataclass(slots=True)
class JobEvent:
    id: str | None = None
    type: str | None = None
    payload: Any = None


@dataclass(slots=True)
class CandidateSummary:
    host: int = 0
    srflx: int = 0
    relay: int = 0
    prflx: int = 0
    unknown: int = 0
    total: int = 0


@dataclass(slots=True)
class ConnectDiagnosticEvent:
    stage: str
    message: str
    elapsed_ms: int | None = None
    stage_started_at_ms: int | None = None
    prewarm_hit: bool | None = None
    offer_gathering_ms: int | None = None
    answer_wait_ms: int | None = None
    data_channel_open_ms: int | None = None
    signaling_state: str | None = None
    ice_gathering_state: str | None = None
    ice_connection_state: str | None = None
    connection_state: str | None = None
    data_channel_state: str | None = None
    local_candidate_summary: CandidateSummary | None = None
    remote_candidate_summary: CandidateSummary | None = None
    local_sdp: str | None = None
    remote_sdp: str | None = None
