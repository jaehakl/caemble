from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel as PydanticBaseModel
from pydantic import EmailStr, Field, field_serializer, field_validator, model_validator
from utils.datetime_utils import serialize_datetime_utc, to_utc_datetime


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


class ExperimentSourceBundle(BaseModel):
    formatVersion: Literal[1]
    files: Dict[str, str]

    @model_validator(mode="after")
    def validate_files(self):
        import re

        allowed_task = re.compile(r"^tasks/[A-Za-z][A-Za-z0-9_-]*\.tsx$")
        invalid = [
            path
            for path in self.files
            if path not in {"experiment.tsx", "simulate.py"}
            and allowed_task.fullmatch(path) is None
        ]
        if invalid:
            raise ValueError(f"Experiment source file path is not allowed: {invalid[0]}")
        if "experiment.tsx" not in self.files or "simulate.py" not in self.files:
            raise ValueError("Experiment source bundle requires experiment.tsx and simulate.py.")
        if not any(allowed_task.fullmatch(path) for path in self.files):
            raise ValueError("Experiment source bundle requires at least one Task file.")
        total_bytes = 0
        for path, source in self.files.items():
            try:
                source_bytes = len(source.encode("utf-8"))
            except UnicodeEncodeError as error:
                raise ValueError(f"Experiment source {path} must contain valid UTF-8 text.") from error
            if source_bytes > 1024 * 1024:
                raise ValueError(f"Experiment source {path} exceeds 1 MiB.")
            total_bytes += source_bytes
        if total_bytes > 1024 * 1024:
            raise ValueError("Experiment source bundle exceeds 1 MiB.")
        if not self.files["experiment.tsx"].strip() or not self.files["simulate.py"].strip():
            raise ValueError("Experiment program sources must not be empty.")
        return self


class ExperimentBase(OwnedTimestampFields):
    parent_id: Optional[int] = None
    name: str = Field(..., min_length=1)
    description: Optional[str] = None
    source_bundle: ExperimentSourceBundle


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


class SaveExperimentRequest(BaseModel):
    id: Optional[int] = None
    name: str = Field(..., min_length=1)
    description: Optional[str] = None
    sourceBundle: ExperimentSourceBundle
    bundleHash: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    semanticHash: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    semanticHashVersion: Literal[2]
    baseBundleHash: Optional[str] = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )
    baseSemanticHash: Optional[str] = Field(default=None, pattern=r"^[0-9a-f]{64}$")


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


class MeasurementContextListRequest(GetListRequestBase):
    structure_id: int
    experiment_id: int
    sort: Optional[List[str]] = Field(
        default_factory=lambda: ["updated_at", "desc"]
    )


class MeasurementPairListRequest(BaseModel):
    offset: int = Field(default=0, ge=0)
    limit: Optional[int] = Field(default=20, ge=1, le=100)
    search_text: Optional[str] = None
    structure_id: Optional[int] = Field(default=None, gt=0)
    experiment_id: Optional[int] = Field(default=None, gt=0)
    exclude_structure_id: Optional[int] = Field(default=None, gt=0)
    exclude_experiment_id: Optional[int] = Field(default=None, gt=0)
    structure_scope: Literal["visible", "mine", "public"] = "visible"
    experiment_scope: Literal["visible", "mine", "public"] = "visible"
    measured_from: Optional[datetime] = None
    measured_to: Optional[datetime] = None
    sort: Optional[List[str]] = None

    @field_validator("measured_from", "measured_to")
    @classmethod
    def normalize_measured_at(cls, value: Optional[datetime]) -> Optional[datetime]:
        return to_utc_datetime(value) if value is not None else None

    @model_validator(mode="after")
    def validate_pair_list(self):
        allowed_sort_fields = {
            "latest_measurement_at",
            "measurement_count",
            "structure_name",
            "experiment_name",
        }
        if self.sort:
            if len(self.sort) > 2 or self.sort[0] not in allowed_sort_fields:
                raise ValueError("Unsupported Measurement pair sort.")
            if len(self.sort) == 2 and self.sort[1].lower() not in {"asc", "desc"}:
                raise ValueError("Measurement pair sort direction must be asc or desc.")
        if self.measured_from and self.measured_to and self.measured_from > self.measured_to:
            raise ValueError("measured_from must not be after measured_to.")
        return self


class MeasurementPairSummary(BaseModel):
    structure_id: int
    structure_name: str
    structure_description: Optional[str] = None
    structure_user_id: Optional[str] = None
    experiment_id: int
    experiment_name: str
    experiment_description: Optional[str] = None
    experiment_user_id: Optional[str] = None
    measurement_count: int
    latest_measurement_id: int
    latest_measurement_at: datetime


class MeasurementPairListResponse(BaseModel):
    total: int
    items: List[MeasurementPairSummary]


class CodeEntityHistoryRequest(BaseModel):
    id: int = Field(..., gt=0)


class CodeEntityHistoryItem(OwnedTimestampFields):
    id: int
    parent_id: Optional[int] = None
    name: str
    description: Optional[str] = None


class CodeEntityHistoryResponse(BaseModel):
    selected_id: int
    root_id: int
    items: List[CodeEntityHistoryItem]


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
    overwrite: bool = False
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
