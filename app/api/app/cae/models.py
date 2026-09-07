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
    experiment_id: int = Field(gt=0)
    experiment_source_hash: str
    mode: Literal["generate", "candidate", "measurement"]
    catalog_revision: str
    builder_version: Literal["1"]
    items: list[BatchItemManifest] = Field(min_length=1)

    @model_validator(mode="before")
    @classmethod
    def require_client_artifacts(cls, value):
        if isinstance(value, dict) and "items" not in value:
            raise ValueError("Server prepare was removed. Update the Caemble client and upload built artifacts.")
        return value

    @model_validator(mode="after")
    def check_inputs(self):
        if [item.index for item in self.items] != list(range(1, len(self.items) + 1)):
            raise ValueError("Artifact item indexes must be contiguous and start at one.")
        ids = [item.measurement_id for item in self.items if item.measurement_id is not None]
        if len(ids) != len(set(ids)):
            raise ValueError("A Measurement may only appear once in a batch.")
        if self.mode != "generate" and len(self.items) != 1:
            raise ValueError("Only generated batches may contain multiple items.")
        if self.mode == "measurement" and not ids:
            raise ValueError("measurement mode requires an existing measurement_id.")
        return self


class BatchRetryRequest(BaseModel):
    job_ids: list[UUID] | None = None


class BatchReadRequest(BaseModel):
    event_id: int = Field(ge=0)
