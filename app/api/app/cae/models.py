from typing import Literal
from uuid import UUID

from pydantic import ConfigDict, Field, model_validator

from models import BaseModel


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
    execution_mode: Literal["brief", "full"] = "full"
    source_bundle: dict | None = None
    experiment_source_hash: str
    mode: Literal["generate", "candidate", "measurement"]
    catalog_revision: str
    builder_version: Literal["2"]
    storage_version: Literal[1] | None = None
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
        elif self.experiment_id is None or self.execution_mode != "full" or self.source_bundle is not None:
            raise ValueError("Saved batches require an Experiment and Full execution.")
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


class BatchReadRequest(BaseModel):
    event_id: int = Field(ge=0)
