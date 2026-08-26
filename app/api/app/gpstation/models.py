from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import Field

from models import BaseModel


AccessKeyScope = Literal["client", "launcher"]
JobState = str


class OkResponse(BaseModel):
    ok: bool = True


class LauncherView(BaseModel):
    id: str
    user_id: str
    launcher_name: str
    status: str
    slave_app_ids: List[str]
    connected_at: datetime
    last_heartbeat_at: datetime
    ip_address: Optional[str] = None
    disconnected_at: Optional[datetime] = None


class JobCreateRequest(BaseModel):
    handler_type: str
    slave_app_id: str = "ai"
    offer: Dict[str, Any]


class JobData(BaseModel):
    id: str
    user_id: str
    handler_type: str
    slave_app_id: str
    offer: Dict[str, Any]
    answer: Optional[Dict[str, Any]] = None
    progress: List[Any] = Field(default_factory=list)
    state: JobState
    launcher_id: Optional[str] = None
    assigned_at: Optional[datetime] = None
    answer_ready_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    cancel_requested_at: Optional[datetime] = None
    last_error: Optional[str] = None
    attempt_count: int = 0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class JobSummary(BaseModel):
    id: str
    user_id: str
    handler_type: str
    slave_app_id: str
    state: JobState
    launcher_id: Optional[str] = None
    assigned_at: Optional[datetime] = None
    answer_ready_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    cancel_requested_at: Optional[datetime] = None
    last_error: Optional[str] = None
    attempt_count: int = 0
    latest_progress: Any = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class JobCreateResult(BaseModel):
    job: JobData
    answer_wait_url: str


class JobAnswerWaitResult(BaseModel):
    job_id: str
    state: JobState
    answer: Optional[Dict[str, Any]] = None
    last_error: Optional[str] = None


class AccessKeyData(BaseModel):
    id: str
    user_id: str
    key_type: str
    name: str
    key_prefix: str
    scopes: List[str]
    status: str
    rate_limit_per_minute: Optional[int] = None
    allowed_ips: Optional[List[str]] = None
    allowed_origins: Optional[List[str]] = None
    last_used_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    revoked_at: Optional[datetime] = None


class AccessKeyCreate(BaseModel):
    name: str
    scopes: List[AccessKeyScope]
    expires_at: Optional[datetime] = None


class AccessKeyCreateResult(BaseModel):
    access_key: AccessKeyData
    secret: str


class CrudListRequest(BaseModel):
    offset: int = 0
    limit: Optional[int] = 100
    selected_ids: List[str] = Field(default_factory=list)
    search_text: Optional[str] = None
    text_filter: Dict[str, List[str]] = Field(default_factory=dict)
    filter: Dict[str, List[Any]] = Field(default_factory=dict)
    sort: Optional[List[str]] = None


class CrudListResponse(BaseModel):
    total: int
    items: List[Dict[str, Any]]


class CrudDeleteRequest(BaseModel):
    ids: List[str]


class CrudDeleteResponse(BaseModel):
    deleted: int


class LauncherReconcileResponse(BaseModel):
    ok: bool = True
    launchers: int


class LauncherRuntimeData(BaseModel):
    launcher_id: str
    current_job_id: str | None = None
    loaded_slave_app_id: str | None = None
    worker_status: str | None = None
    resetting: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)
