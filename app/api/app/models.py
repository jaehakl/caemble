from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel as PydanticBaseModel
from pydantic import ConfigDict, EmailStr, Field, field_serializer, field_validator, model_validator
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


class ExperimentSourceBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    formatVersion: Literal[2]
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
    source_hash: str = Field(..., pattern=r"^[0-9a-f]{64}$")


class SaveExperimentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Optional[int] = None
    name: str = Field(..., min_length=1)
    description: Optional[str] = None
    sourceBundle: ExperimentSourceBundle
    bundleHash: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    baseBundleHash: Optional[str] = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )


class SaveCodeEntityResponse(BaseModel):
    id: int
    action: Literal["created", "updated", "forked"]
    parentId: Optional[int] = None
    sourceHash: str = Field(..., pattern=r"^[0-9a-f]{64}$")


class MeasurementBase(OwnedTimestampFields):
    user_id: str
    experiment_id: int
    vars: Dict[str, Any]
    material_parameters: Dict[str, Any]
    recorded_at: Optional[datetime] = None


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
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1)
    quantity_kind: Optional[str] = Field(default=None, min_length=1)
    tensor_order: int = Field(..., ge=0)
    dtype: str = Field(..., min_length=1)
    data_schema: Dict[str, Any]
    data: Any


class MeasurementCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    experiment_id: int = Field(..., gt=0)
    experiment_source_hash: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    vars: Dict[str, Any]
    material_parameters: Dict[str, Any]

    @field_validator("material_parameters")
    @classmethod
    def validate_material_parameters(cls, value: Dict[str, Any]):
        if set(value) != {"schemaVersion", "experiment", "tasks"}:
            raise ValueError(
                "material_parameters must contain exactly schemaVersion, experiment, and tasks."
            )
        if value["schemaVersion"] != 2:
            raise ValueError("material_parameters.schemaVersion must be 2.")
        def validate_frozen(snapshot: Any, path: str):
            if not isinstance(snapshot, dict) or set(snapshot) not in (
                {"schemaVersion", "materials"},
                {"schemaVersion", "materials", "materialColors"},
            ):
                raise ValueError(f"{path} must be a frozen Material snapshot.")
            if snapshot["schemaVersion"] != 1 or not isinstance(snapshot["materials"], dict):
                raise ValueError(f"{path} must use frozen Material schemaVersion 1.")
            if "materialColors" in snapshot and not isinstance(snapshot["materialColors"], dict):
                raise ValueError(f"{path}.materialColors must be an object.")

        validate_frozen(value["experiment"], "material_parameters.experiment")
        if not isinstance(value["tasks"], dict) or any(
            not isinstance(task_name, str)
            or not task_name.strip()
            or not isinstance(parameters, dict)
            for task_name, parameters in value["tasks"].items()
        ):
            raise ValueError("material_parameters.tasks must map Task names to objects.")
        for task_name, parameters in value["tasks"].items():
            validate_frozen(parameters, f"material_parameters.tasks.{task_name}")
        return value


class MeasurementRecordRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recorded_data: List[MeasurementSaveRecordedData] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_recorded_data_names(self):
        names = [item.name for item in self.recorded_data]
        if len(names) != len(set(names)):
            raise ValueError("RecordedData names must be unique within a Measurement.")
        return self


class MeasurementSaveResponse(BaseModel):
    id: int


class RecordedDataBase(OwnedTimestampFields):
    user_id: str
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
    experiment_id: int
    model_url: Optional[str] = None
    file_size: Optional[int] = Field(default=None, ge=0)


class DesignerModelBase(ModelArtifactBase):
    pass


class PredictorModelBase(ModelArtifactBase):
    pass
