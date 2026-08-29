from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, EmailStr, Field, RootModel, StrictFloat, StrictInt, model_validator

from model_validators import (
    validate_calculation_data_axis,
    validate_calculation_data_output,
)


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


class CalculationListRequest(GetListRequestBase):
    experiment_id: Optional[int] = None


class CalculationDataListRequest(GetListRequestBase):
    experiment_id: StrictInt
    selected_ids: List[StrictInt] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def validate_exact_selection(self):
        if self.experiment_id <= 0:
            raise ValueError("experiment_id must be a positive integer.")
        if not self.selected_ids:
            raise ValueError("selected_ids must contain at least one CalculationData ID.")
        if any(item_id <= 0 for item_id in self.selected_ids):
            raise ValueError("selected_ids must contain only positive integers.")
        if len(set(self.selected_ids)) != len(self.selected_ids):
            raise ValueError("selected_ids must not contain duplicates.")
        return self


class RecordedDataListRequest(GetListRequestBase):
    include_system: bool = True


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


class MeasurementBase(OwnedTimestampFields):
    user_id: str
    experiment_id: int
    vars: Dict[str, Any]
    material_parameters: Dict[str, Any]
    recorded_at: Optional[datetime] = None
    calculation_data_count: int = 0


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


class CalculationBase(TimestampFields):
    experiment_id: int
    name: str
    description: Optional[str] = None
    source_code: str


CalculationDataDType = Literal[
    "float32",
    "float64",
    "int8",
    "int16",
    "int32",
    "uint8",
    "uint16",
    "uint32",
]


class CalculationDataAxis(BaseModel):
    name: str
    ticks: List[Union[StrictInt, StrictFloat]]
    unit: Optional[str] = None
    _validate_ticks = model_validator(mode="after")(validate_calculation_data_axis)


class CalculationDataOutput(BaseModel):
    dtype: CalculationDataDType
    shape: List[StrictInt]
    data: Any
    axes: List[CalculationDataAxis]

    _validate_output = model_validator(mode="after")(validate_calculation_data_output)


class CalculationDataBase(TimestampFields):
    calculation_id: int
    measurement_id: int
    data: CalculationDataOutput


class CalculationDataListResponse(BaseModel):
    total: int
    items: List[CalculationDataBase]
