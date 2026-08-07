from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel as PydanticBaseModel
from pydantic import ConfigDict, EmailStr, Field, field_serializer, field_validator
from utils.datetime_utils import serialize_datetime_utc


class BaseModel(PydanticBaseModel):
    @field_serializer("*", when_used="json")
    def serialize_datetimes(self, value: Any) -> Any:
        return serialize_datetime_utc(value)


class RoleEnum(str, Enum):
    admin = "admin"
    user = "user"


class UserData(BaseModel):
    id: str
    email: Optional[EmailStr] = None
    display_name: Optional[str] = None
    picture_url: Optional[str] = None
    is_active: Optional[bool] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    roles: List[RoleEnum]


class AuthenticatedUserData(UserData):
    pass


AccessKeyScope = Literal["client", "launcher"]
JobState = Literal[
    "queued",
    "assigned",
    "answer_ready",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "killed",
]


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
    model_config = ConfigDict(extra="forbid")

    handler_type: str = Field(min_length=1, max_length=128)
    slave_app_id: str = Field(default="ai", min_length=1, max_length=128)
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
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=128)
    scopes: List[AccessKeyScope] = Field(min_length=1, max_length=2)
    expires_at: Optional[datetime] = None

    @field_validator("scopes", mode="before")
    @classmethod
    def deduplicate_scopes(cls, value: Any) -> Any:
        return list(dict.fromkeys(value)) if isinstance(value, list) else value


class AccessKeyCreateResult(BaseModel):
    access_key: AccessKeyData
    secret: str


class CrudListRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    offset: int = Field(default=0, ge=0)
    limit: Optional[int] = Field(default=100, ge=1, le=1000)
    selected_ids: List[str] = Field(default_factory=list, max_length=1000)
    search_text: Optional[str] = None
    text_filter: Dict[str, List[str]] = Field(default_factory=dict)
    filter: Dict[str, List[Any]] = Field(default_factory=dict)
    sort: Optional[List[str]] = None


class CrudListResponse(BaseModel):
    total: int
    items: List[Dict[str, Any]]


class CrudDeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ids: List[str] = Field(max_length=1000)


class CrudDeleteResponse(BaseModel):
    deleted: int


class GetListRequestBase(BaseModel):
    scope: Literal["visible", "mine", "public"] = "visible"
    offset: Optional[int] = 0
    limit: Optional[int] = None
    selected_ids: Optional[List[int]] = None
    search_text: Optional[str] = None
    text_filter: Optional[Dict[str, List[str]]] = None
    filter: Optional[Dict[str, List[Any]]] = None
    sort: Optional[List[str]] = None
    random: Optional[bool] = False


class GetListResponseBase(BaseModel):
    total: int
    items: List[Any]


class UpsertResponseBase(BaseModel):
    id: int
    fk_not_found: Optional[Dict[str, List[int]]] = None


class TimestampFields(BaseModel):
    id: Optional[int] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class OwnedTimestampFields(TimestampFields):
    user_id: Optional[str] = None


class MaterialBase(OwnedTimestampFields):
    inchi: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")

    @field_validator("color")
    @classmethod
    def normalize_color(cls, value: Optional[str]) -> Optional[str]:
        return value.lower() if value is not None else None


class MaterialNameBase(OwnedTimestampFields):
    material_id: int
    name: str = Field(..., min_length=1)


class MaterialParameterBase(OwnedTimestampFields):
    material_id: int
    name: str = Field(..., min_length=1)
    value: Any
    source: Optional[str] = None
    version: Optional[str] = None
    description: Optional[str] = None
    temperature: Optional[float] = None
    pressure: Optional[float] = None
    frequency: Optional[float] = None


class MaterialParameterQualifierBase(TimestampFields):
    material_parameter_id: int
    name: str = Field(..., min_length=1)
    value: float


class CodeEntityBase(OwnedTimestampFields):
    parent_id: Optional[int] = None
    name: str = Field(..., min_length=1)
    description: Optional[str] = None
    code: str = Field(..., min_length=1)


class GeometryBase(CodeEntityBase):
    pass


class StructureBase(CodeEntityBase):
    pass


class ExperimentBase(CodeEntityBase):
    simulation_code: Optional[str] = None


class SaveCodeEntityRequest(BaseModel):
    id: Optional[int] = None
    name: str = Field(..., min_length=1)
    description: Optional[str] = None
    code: str = Field(..., min_length=1)
    rawCodeHash: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    semanticHash: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    semanticHashVersion: Literal[1]
    baseRawCodeHash: Optional[str] = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )
    baseSemanticHash: Optional[str] = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )


class SaveExperimentRequest(SaveCodeEntityRequest):
    simulationCode: str = Field(..., min_length=1)
    simulationRawCodeHash: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    baseSimulationRawCodeHash: Optional[str] = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )


class SaveCodeEntityResponse(BaseModel):
    id: int
    action: Literal["created", "updated", "forked"]
    parentId: Optional[int] = None


class SampleBase(OwnedTimestampFields):
    structure_id: int
    vars: Dict[str, Any] = Field(default_factory=dict)
    material_parameters: Dict[str, Any] = Field(default_factory=dict)


class SetupBase(OwnedTimestampFields):
    experiment_id: int
    vars: Dict[str, Any] = Field(default_factory=dict)
    material_parameters: Dict[str, Any] = Field(default_factory=dict)


class MeasurementBase(OwnedTimestampFields):
    sample_id: int
    setup_id: int


class MeasurementContextListRequest(BaseModel):
    structure_id: int
    experiment_id: int


class MeasurementSaveRecordedData(BaseModel):
    name: str = Field(..., min_length=1)
    quantity_kind: Optional[str] = Field(default=None, min_length=1)
    tensor_order: int = Field(..., ge=0)
    dtype: str = Field(..., min_length=1)
    data_schema: Dict[str, Any]
    data: Any


class MeasurementSaveRequest(BaseModel):
    sample_id: int
    setup_id: int
    recorded_data: List[MeasurementSaveRecordedData] = Field(default_factory=list)


class MeasurementSaveResponse(BaseModel):
    id: int


class RecordedDataBase(OwnedTimestampFields):
    measurement_id: int
    name: str = Field(..., min_length=1)
    quantity_kind: Optional[str] = Field(default=None, min_length=1)
    tensor_order: int = Field(..., ge=0)
    dtype: str = Field(..., min_length=1)
    data_schema: Optional[Dict[str, Any]] = None
    data: Any = None
    data_url: Optional[str] = None
    file_size: Optional[int] = Field(default=None, ge=0)


class ModelArtifactBase(OwnedTimestampFields):
    structure_id: int
    experiment_id: int
    model_url: Optional[str] = None
    file_size: Optional[int] = Field(default=None, ge=0)


class DesignerModelBase(ModelArtifactBase):
    pass


class PredictorModelBase(ModelArtifactBase):
    pass
