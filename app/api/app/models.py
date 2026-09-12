from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, EmailStr, Field, RootModel, StrictFloat, StrictInt, field_validator, model_validator

from model_validators import (
    validate_calculation_data_axis,
    validate_calculation_data_output,
    validate_calculation_output_layout,
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
    scope: Literal["visible", "mine", "public"] = "visible"
    offset: Optional[int] = 0
    limit: Optional[int] = None
    selected_ids: Optional[List[int]] = None
    search_text: Optional[str] = None
    text_filter: Optional[Dict[str, List[str]]] = None
    filter: Optional[Dict[str, List[Any]]] = None
    null_filter: Optional[Dict[str, str]] = None
    sort: Optional[Union[List[str], List[List[str]]]] = None
    random: Optional[bool] = False


class DemoExperimentUpdateRequest(BaseModel):
    experiment_ids: List[StrictInt]
    default_experiment_id: Optional[StrictInt] = None

    @model_validator(mode="after")
    def validate_demo_selection(self):
        if any(experiment_id <= 0 for experiment_id in self.experiment_ids):
            raise ValueError("experiment_ids must contain only positive integers.")
        if len(set(self.experiment_ids)) != len(self.experiment_ids):
            raise ValueError("experiment_ids must not contain duplicates.")
        if self.experiment_ids and self.default_experiment_id not in self.experiment_ids:
            raise ValueError("default_experiment_id must be one of experiment_ids.")
        if not self.experiment_ids and self.default_experiment_id is not None:
            raise ValueError("default_experiment_id must be null when experiment_ids is empty.")
        return self


class CalculationListRequest(GetListRequestBase):
    experiment_id: Optional[int] = None


class ExperimentRecordListRequest(GetListRequestBase):
    experiment_id: StrictInt


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
    experiment_id: Optional[StrictInt] = None
    experiment_record_ids: Optional[List[StrictInt]] = None


class TimestampFields(BaseModel):
    id: Optional[int] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class OwnedTimestampFields(TimestampFields):
    user_id: Optional[str] = None


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
    result_contracts: Optional[Dict[str, Any]] = None


class ExperimentRecordContract(BaseModel):
    name: str
    quantity_kind: Optional[str] = None
    tensor_order: int
    dtype: str
    data_schema: Optional[Dict[str, Any]] = None


class ExperimentRecordBase(TimestampFields, ExperimentRecordContract):
    experiment_id: int
    contract_hash: str


class ExperimentRecordListResponse(BaseModel):
    total: int
    items: List[ExperimentRecordBase]


class CalculationDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: Optional[str] = None
    source_code: str

    @field_validator("name", "source_code")
    @classmethod
    def require_nonempty(cls, value: str, info: Any) -> str:
        if not value.strip():
            raise ValueError(f"Calculation {info.field_name} must not be empty")
        return value.strip() if info.field_name == "name" else value


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
    records: List[ExperimentRecordContract]
    result_contracts: Dict[str, Any]
    copyCalculationsFromExperimentId: Optional[StrictInt] = Field(default=None, gt=0)
    calculations: Optional[List[CalculationDefinition]] = None

    @model_validator(mode="after")
    def validate_calculation_copy(self):
        if self.copyCalculationsFromExperimentId is not None or self.calculations is not None:
            if self.mode != "create":
                raise ValueError("Calculation copy inputs are only allowed when creating an Experiment")
            if self.copyCalculationsFromExperimentId is not None and self.calculations is not None:
                raise ValueError("Specify a source Experiment or Calculation definitions, not both")
        names = [item.name for item in self.calculations or []]
        if len(names) != len(set(names)):
            raise ValueError("Calculation names must be unique within an Experiment")
        return self


class MeasurementBase(OwnedTimestampFields):
    user_id: str
    experiment_id: int
    vars: Dict[str, Any]
    material_snapshot: Dict[str, Any]
    recorded_at: Optional[datetime] = None
    calculation_data_count: int = 0


class MeasurementRecordedDataLeaf(BaseModel):
    experiment_record_id: StrictInt
    quantity_kind: Optional[str] = None
    tensor_order: int
    dtype: str
    data_schema: Optional[Dict[str, Any]] = None
    data: Any


class MeasurementRecordedDataGroup(
    RootModel[Dict[str, Union[MeasurementRecordedDataLeaf, "MeasurementRecordedDataGroup"]]]
):
    pass


MeasurementRecordedDataNode = Union[MeasurementRecordedDataLeaf, MeasurementRecordedDataGroup]


class MeasurementCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    experiment_id: int
    experiment_source_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    vars: Dict[str, Any]
    material_snapshot: Dict[str, Any]

    @field_validator("material_snapshot")
    @classmethod
    def check_material_snapshot(cls, value):
        from service.material_snapshot import validate_material_snapshot

        return validate_material_snapshot(value)


class MeasurementRecordedDataResponse(BaseModel):
    recorded_data: Dict[str, MeasurementRecordedDataNode] = Field(default_factory=dict)

    result_contracts: Optional[Dict[str, Any]] = None


class MeasurementVisualizationsResponse(BaseModel):
    visualizations: Dict[str, Dict[str, Any]] = Field(default_factory=dict)


class RecordedDataBase(OwnedTimestampFields):
    user_id: str
    measurement_id: int
    experiment_record_id: int
    data: Any = None
    data_url: Optional[str] = None
    file_size: Optional[int] = None


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
    ticks: Union[List[Union[StrictInt, StrictFloat]], Dict[str, Any]]
    unit: Optional[str] = None
    _validate_ticks = model_validator(mode="after")(validate_calculation_data_axis)


class CalculationOutputLayout(BaseModel):
    dtype: CalculationDataDType
    shape: List[StrictInt]
    axes: List[CalculationDataAxis]

    _validate_layout = model_validator(mode="after")(validate_calculation_output_layout)


class CalculationBase(TimestampFields):
    revision: int = Field(default=1, ge=1)
    base_revision: int | None = Field(default=None, ge=1)
    experiment_id: int
    name: str
    description: Optional[str] = None
    source_code: str
    source_hash: Optional[str] = None
    output_layout: Optional[CalculationOutputLayout] = None
    preflight_measurement_id: Optional[StrictInt] = None
    contract_status: Literal["ready", "needs_preflight"] = "needs_preflight"
    experiment_record_ids: List[StrictInt] = Field(default_factory=list)


class CalculationDataOutput(BaseModel):
    dtype: CalculationDataDType
    shape: List[StrictInt]
    data: Any
    axes: List[CalculationDataAxis]
    summary: Optional[Dict[str, Any]] = Field(default=None, exclude_if=lambda value: value is None)

    _validate_output = model_validator(mode="after")(validate_calculation_data_output)


class CalculationDataBase(TimestampFields):
    calculation_id: int
    measurement_id: int
    data: CalculationDataOutput


class CalculationDataListResponse(BaseModel):
    total: int
    items: List[CalculationDataBase]
