from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictFloat,
    StrictInt,
    field_validator,
    model_validator,
)

from core.schemas import GetListRequestBase, TimestampFields
from calculation.validation import validate_calculation_data_axis, validate_calculation_data_output, validate_calculation_output_layout


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
    base_source_revision: int | None = Field(default=None, ge=1)
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


class CalculationMetadataUpdate(BaseModel):
    name: str = Field(min_length=1)
    description: str | None = None
    base_source_revision: int = Field(ge=1)


class CalculationListItem(CalculationBase):
    source_revision: int
    source_owner_id: str | None
    validated_source_revision: int | None
    source_id: int = Field(ge=1)
    calculation_data_count: int = Field(default=0, ge=0)
    recorded_measurement_count: int = Field(default=0, ge=0)
    measurement_count: int = Field(default=0, ge=0)


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
