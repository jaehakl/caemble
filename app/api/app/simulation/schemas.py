from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    StrictInt,
    field_validator,
    model_validator,
)

from core.schemas import GetListRequestBase, TimestampFields, OwnedTimestampFields
from simulation.contracts import ExperimentSourceBundle, ExperimentRecordContract
from calculation.schemas import CalculationDefinition
from uuid import UUID
from sdk.protocol.execution import ResourceRequest


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


class ExperimentRecordListRequest(GetListRequestBase):
    experiment_id: StrictInt


class RecordedDataListRequest(GetListRequestBase):
    experiment_id: Optional[StrictInt] = None
    experiment_record_ids: Optional[List[StrictInt]] = None


class ExperimentBase(OwnedTimestampFields):
    thumbnail_url: Optional[str] = None
    initial_measurement_id: Optional[int] = None
    viewer_defaults: Optional[Dict[str, Any]] = None
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


class ExperimentRecordBase(TimestampFields, ExperimentRecordContract):
    experiment_id: int
    contract_hash: str


class ExperimentRecordListResponse(BaseModel):
    total: int
    items: List[ExperimentRecordBase]


class SaveExperimentRequest(BaseModel):
    requestId: Optional[str] = Field(default=None, pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    preflightBatchId: Optional[str] = Field(default=None, pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    thumbnail: Optional[str] = Field(default=None, max_length=700000)
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
        from simulation.services.material_snapshot import validate_material_snapshot

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


class BatchItemManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    index: int = Field(strict=True, ge=1)
    input_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    byte_length: int = Field(strict=True, gt=0, le=2147483647)
    measurement_id: int | None = Field(default=None, gt=0)


class BatchCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    experiment_id: int | None = Field(default=None, gt=0)
    preflight: bool = False
    source_bundle: dict | None = None
    experiment_source_hash: str
    mode: Literal["generate", "candidate", "measurement"]
    catalog_revision: str
    builder_version: Literal["2"]
    storage_version: Literal[1] | None = None
    resources: ResourceRequest | None = None
    items: list[BatchItemManifest] = Field(min_length=1)

    @model_validator(mode="before")
    @classmethod
    def require_client_artifacts(cls, value):
        if isinstance(value, dict) and "items" not in value:
            raise ValueError("Server prepare was removed. Update the Caemble client and upload built artifacts.")
        return value

    @model_validator(mode="after")
    def check_inputs(self):
        if self.preflight:
            if self.experiment_id is not None or self.mode != "candidate" or len(self.items) != 1 or any(item.measurement_id for item in self.items):
                raise ValueError("Preflight requires one unsaved candidate.")
            if self.storage_version != 1 or not isinstance(self.source_bundle, dict):
                raise ValueError("Preflight requires a source bundle and object storage transport.")
        elif self.experiment_id is None or self.source_bundle is not None:
            raise ValueError("Saved batches require an Experiment and the original execution settings.")
        if [item.index for item in self.items] != list(range(1, len(self.items) + 1)):
            raise ValueError("Artifact item indexes must be contiguous and start at one.")
        ids = [item.measurement_id for item in self.items if item.measurement_id is not None]
        if len(ids) != len(set(ids)):
            raise ValueError("A Measurement may only appear once in a batch.")
        if self.mode == "measurement" and len(self.items) != 1:
            raise ValueError("Measurement batches must contain exactly one item.")
        if self.mode == "measurement" and not ids:
            raise ValueError("measurement mode requires an existing measurement_id.")
        return self


class BatchRetryRequest(BaseModel):
    job_ids: list[UUID] | None = None


class BatchCancelRequest(BaseModel):
    job_ids: list[UUID] | None = Field(default=None, min_length=1)


class BatchReadRequest(BaseModel):
    event_id: int = Field(ge=0)
