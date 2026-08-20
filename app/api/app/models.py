from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, EmailStr, Field


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
    geometry_namespace: Optional[str] = None
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


class GeometryNamespaceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    namespace: str


class GeometrySnapshotImport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    exportName: str
    alias: str
    geometryVersionId: int = Field(..., gt=0)
    coordinate: str
    moduleHash: str


class GeometryModuleSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    geometryVersionId: int = Field(..., gt=0)
    coordinate: str
    moduleFormatVersion: Literal[4]
    cadApiVersion: Literal[7, 8]
    description: Optional[str]
    source: str = Field(..., min_length=1)
    sourceHash: str
    moduleHash: str
    imports: List[GeometrySnapshotImport] = Field(default_factory=list, max_length=64)


class GeometrySnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[2]
    entryImports: List[GeometrySnapshotImport] = Field(default_factory=list, max_length=64)
    modules: List[GeometryModuleSnapshot] = Field(default_factory=list, max_length=256)


class GeometryRepositoryCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: str
    description: Optional[str] = None


class GeometryRepositoryRow(OwnedTimestampFields):
    namespace: str
    slug: str
    description: Optional[str] = None
    archived_at: Optional[datetime] = None


class GeometryPackageRow(TimestampFields):
    repository_id: int
    name: str
    user_id: Optional[str] = None
    namespace: Optional[str] = None
    repository_archived_at: Optional[datetime] = None
    version_count: int = 0
    latest_version: Optional[str] = None


class GeometryVersionRow(TimestampFields):
    package_id: int
    version_major: int
    version_minor: int
    version_patch: int
    description: Optional[str] = None
    source: str
    source_hash: str
    module_hash: str
    module_format_version: Literal[4]
    cad_api_version: Literal[7, 8]
    archived_at: Optional[datetime] = None
    repository_id: Optional[int] = None
    namespace: Optional[str] = None
    repository: Optional[str] = None
    package_name: Optional[str] = None
    coordinate: Optional[str] = None
    version: Optional[str] = None


class GeometryExperimentReferenceRow(OwnedTimestampFields):
    parent_id: Optional[int] = None
    name: str
    description: Optional[str] = None
    entry_alias: Optional[str] = None


class GeometryPublishDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    draftId: str = Field(..., min_length=1, max_length=128)
    baseGeometryVersionId: Optional[int] = Field(default=None, gt=0)
    repositoryId: Optional[int] = Field(default=None, gt=0)
    repository: str
    package: str
    bump: Literal["patch", "minor", "major"] = "patch"
    version: Optional[str] = None
    description: Optional[str] = None
    source: str = Field(..., min_length=1)


class GeometryPublishPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    targetDraftId: str = Field(..., min_length=1, max_length=128)
    drafts: List[GeometryPublishDraft] = Field(..., min_length=1, max_length=256)


class GeometryPublishRequest(GeometryPublishPlanRequest):
    planHash: str


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

    formatVersion: Literal[5]
    files: Dict[str, str]
    geometrySnapshot: GeometrySnapshot


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
