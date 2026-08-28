from datetime import datetime
from enum import Enum
import math
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, EmailStr, Field, RootModel, StrictFloat, StrictInt, model_validator


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


class CalculationListRequest(GetListRequestBase):
    experiment_id: Optional[int] = None


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
    calculations: int = 0


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

    @model_validator(mode="after")
    def validate_ticks(self) -> "CalculationDataAxis":
        if any(isinstance(value, bool) or not math.isfinite(value) for value in self.ticks):
            raise ValueError("CalculationData axis ticks must be finite numbers.")
        return self


class CalculationDataOutput(BaseModel):
    dtype: CalculationDataDType
    shape: List[StrictInt]
    data: Any
    axes: List[CalculationDataAxis]

    @model_validator(mode="after")
    def validate_output(self) -> "CalculationDataOutput":
        if len(self.shape) > 2:
            raise ValueError("CalculationData output rank must be between 0 and 2.")
        if any(isinstance(length, bool) or length < 0 for length in self.shape):
            raise ValueError("CalculationData shape lengths must be non-negative integers.")
        if len(self.axes) != len(self.shape):
            raise ValueError("CalculationData axes must match output rank.")
        for index, axis in enumerate(self.axes):
            if len(axis.ticks) != self.shape[index]:
                raise ValueError("CalculationData axis ticks must match output shape.")

        values = self.data if isinstance(self.data, list) else [self.data]
        expected = math.prod(self.shape) if self.shape else 1
        if expected > 5_000_000:
            raise ValueError("CalculationData output exceeds the element limit.")
        if len(values) != expected or (self.shape and not isinstance(self.data, list)) or (not self.shape and isinstance(self.data, list)):
            raise ValueError("CalculationData data must match output shape.")
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
            raise ValueError("CalculationData values must be finite numbers.")

        integer_ranges = {
            "int8": (-128, 127),
            "int16": (-32768, 32767),
            "int32": (-2147483648, 2147483647),
            "uint8": (0, 255),
            "uint16": (0, 65535),
            "uint32": (0, 4294967295),
        }
        bounds = integer_ranges.get(self.dtype)
        if bounds and any(not isinstance(value, int) or not bounds[0] <= value <= bounds[1] for value in values):
            raise ValueError(f"CalculationData values must fit {self.dtype}.")
        if self.dtype == "float32" and any(abs(value) > 3.4028234663852886e38 for value in values):
            raise ValueError("CalculationData values must fit float32.")
        return self


class CalculationDataMissingRequest(BaseModel):
    experiment_id: int
    calculation_id: Optional[int] = None
    measurement_id: Optional[int] = None

    @model_validator(mode="after")
    def validate_selector(self) -> "CalculationDataMissingRequest":
        if self.calculation_id is not None and self.measurement_id is not None:
            raise ValueError("calculation_id and measurement_id cannot be combined.")
        return self


class CalculationDataTarget(BaseModel):
    calculation_id: int
    measurement_id: int


class CalculationDataMissingResponse(BaseModel):
    total: int
    items: List[CalculationDataTarget]


class CalculationDataSaveRequest(BaseModel):
    calculation_id: int
    measurement_id: int
    source_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    data: CalculationDataOutput


class CalculationDataSaveResponse(BaseModel):
    id: int
    created: bool


class CalculationDataScalarListRequest(BaseModel):
    calculation_id: int
    exclude_measurement_id: Optional[int] = None


class CalculationDataScalar(BaseModel):
    measurement_id: int
    value: float


class CalculationDataScalarListResponse(BaseModel):
    total: int
    items: List[CalculationDataScalar]
