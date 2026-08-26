from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, EmailStr, Field, RootModel


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
    scope: str = "visible"
    offset: Optional[int] = 0
    limit: Optional[int] = None
    selected_ids: Optional[List[int]] = None
    search_text: Optional[str] = None
    text_filter: Optional[Dict[str, List[str]]] = None
    filter: Optional[Dict[str, List[Any]]] = None
    null_filter: Optional[Dict[str, str]] = None
    sort: Optional[Union[List[str], List[List[str]]]] = None
    random: Optional[bool] = False


class RecordedDataListRequest(GetListRequestBase):
    include_system: bool = True


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
    color: Optional[str] = None


class MaterialNameBase(OwnedTimestampFields):
    material_id: int
    name: str


class MaterialParameterBase(OwnedTimestampFields):
    material_id: int
    name: str
    value: Any
    source: Optional[str] = None
    version: Optional[str] = None
    description: Optional[str] = None
    temperature: Optional[float] = None
    pressure: Optional[float] = None
    frequency: Optional[float] = None


class MaterialParameterQualifierBase(TimestampFields):
    material_parameter_id: int
    name: str
    value: float


class ExperimentSourceBundle(BaseModel):
    files: Dict[str, str]


class ExperimentBase(OwnedTimestampFields):
    user_id: str
    namespace: str
    repository_slug: str
    experiment_key: str
    version_major: int
    version_minor: int
    version_patch: int
    name: str
    description: Optional[str] = None
    source_bundle: ExperimentSourceBundle
    source_hash: str


class SaveExperimentRequest(BaseModel):
    mode: str
    namespace: str
    repository: str
    key: str
    initialVersion: Optional[str] = "0.1.0"
    experimentId: Optional[int] = None
    baseBundleHash: Optional[str] = None
    bump: Optional[str] = None
    name: str
    description: Optional[str] = None
    sourceBundle: ExperimentSourceBundle
    bundleHash: str


class ExperimentDerivedCounts(BaseModel):
    measurements: int = 0
    recordedData: int = 0
    designerModels: int = 0
    predictorModels: int = 0


class SaveExperimentResponse(BaseModel):
    id: int
    action: str
    namespace: str
    repository: str
    key: str
    version: str
    coordinate: str
    bundleHash: str
    sourceLocked: bool
    derivedCounts: ExperimentDerivedCounts


class ExperimentUsageRequest(BaseModel):
    experimentIds: List[int] = Field(default_factory=list)


class MeasurementBase(OwnedTimestampFields):
    user_id: str
    experiment_id: int
    vars: Dict[str, Any]
    material_parameters: Dict[str, Any]
    recorded_at: Optional[datetime] = None


class MeasurementSaveRecordedData(BaseModel):
    quantity_kind: Optional[str] = None
    tensor_order: int
    dtype: str
    data_schema: Dict[str, Any]
    data: Any


class MeasurementSaveRecordedDataGroup(
    RootModel[Dict[str, Union[MeasurementSaveRecordedData, "MeasurementSaveRecordedDataGroup"]]]
):
    pass


MeasurementSaveRecordedDataNode = Union[
    MeasurementSaveRecordedData,
    MeasurementSaveRecordedDataGroup,
]


class MeasurementCreateRequest(BaseModel):
    experiment_id: int
    experiment_source_hash: str
    vars: Dict[str, Any]
    material_parameters: Dict[str, Any]


class MeasurementRecordRequest(BaseModel):
    recorded_data: Dict[str, MeasurementSaveRecordedDataNode] = Field(default_factory=dict)


class MeasurementSaveResponse(BaseModel):
    id: int


class RecordedDataBase(OwnedTimestampFields):
    user_id: str
    measurement_id: int
    name: str
    quantity_kind: Optional[str] = None
    tensor_order: int
    dtype: str
    data_schema: Optional[Dict[str, Any]] = None
    data: Any = None
    data_url: Optional[str] = None
    file_size: Optional[int] = None


class ModelArtifactBase(OwnedTimestampFields):
    experiment_id: int
    model_url: Optional[str] = None
    file_size: Optional[int] = None


class DesignerModelBase(ModelArtifactBase):
    pass


class PredictorModelBase(ModelArtifactBase):
    pass
