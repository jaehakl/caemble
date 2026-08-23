from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator


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
    experiment_namespaces: List[str] = Field(default_factory=list)
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
    null_filter: Optional[Dict[str, Literal["is_null", "is_not_null"]]] = None
    sort: Optional[Union[List[str], List[List[str]]]] = None
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


class ExperimentSourceBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    formatVersion: Literal[6]
    files: Dict[str, str]


class ExperimentBase(OwnedTimestampFields):
    user_id: str
    namespace: str
    repository_slug: str
    experiment_key: str
    version_major: int
    version_minor: int
    version_patch: int
    name: str = Field(..., min_length=1)
    description: Optional[str] = None
    source_bundle: ExperimentSourceBundle
    source_hash: str = Field(..., pattern=r"^[0-9a-f]{64}$")


class SaveExperimentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["create", "overwrite", "new_version"]
    namespace: str
    repository: str
    key: str
    initialVersion: Optional[str] = "0.1.0"
    experimentId: Optional[int] = Field(default=None, gt=0)
    baseBundleHash: Optional[str] = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    bump: Optional[Literal["patch", "minor", "major"]] = None
    name: str = Field(..., min_length=1)
    description: Optional[str] = None
    sourceBundle: ExperimentSourceBundle
    bundleHash: str = Field(..., pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def validate_mode_fields(self) -> "SaveExperimentRequest":
        if self.mode == "create":
            if self.experimentId is not None or self.baseBundleHash is not None or self.bump is not None:
                raise ValueError("create does not accept experimentId, baseBundleHash, or bump")
        elif self.mode == "overwrite":
            if self.experimentId is None or self.baseBundleHash is None:
                raise ValueError("overwrite requires experimentId and baseBundleHash")
            if (
                self.bump is not None
                or "initialVersion" in self.model_fields_set
            ):
                raise ValueError("overwrite does not accept initialVersion or bump")
        else:
            if self.experimentId is None or self.baseBundleHash is None or self.bump is None:
                raise ValueError("new_version requires experimentId, baseBundleHash, and bump")
            if "initialVersion" in self.model_fields_set:
                raise ValueError("new_version does not accept initialVersion")
        return self


class ExperimentDerivedCounts(BaseModel):
    measurements: int = 0
    recordedData: int = 0
    designerModels: int = 0
    predictorModels: int = 0


class SaveExperimentResponse(BaseModel):
    id: int
    action: Literal["create", "overwrite", "new_version"]
    namespace: str
    repository: str
    key: str
    version: str
    coordinate: str
    bundleHash: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    sourceLocked: bool
    derivedCounts: ExperimentDerivedCounts


class ExperimentUsageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    experimentIds: List[int] = Field(default_factory=list, max_length=256)


class MeasurementBase(OwnedTimestampFields):
    user_id: str
    experiment_id: int
    vars: Dict[str, Any]
    material_parameters: Dict[str, Any]
    recorded_at: Optional[datetime] = None


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


class MeasurementRecordRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recorded_data: List[MeasurementSaveRecordedData] = Field(default_factory=list)


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
