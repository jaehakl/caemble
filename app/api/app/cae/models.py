from typing import Any, Literal
from uuid import UUID

from pydantic import Field, model_validator

from models import BaseModel


class BatchCreateRequest(BaseModel):
    request_id: UUID
    experiment_id: int = Field(gt=0)
    experiment_source_hash: str
    mode: Literal["generate", "candidate", "measurement"]
    count: int = Field(default=1, strict=True, gt=0, le=9007199254740991)
    vars: dict[str, Any] | None = None
    material_parameters: dict[str, Any] | None = None
    measurement_id: int | None = Field(default=None, gt=0)
    evaluation_timeout_ms: int = Field(default=3000, gt=0, le=30000)

    @model_validator(mode="after")
    def check_inputs(self):
        if self.mode != "generate" and self.count != 1:
            raise ValueError("Only generated batches may contain multiple items.")
        if self.mode == "candidate" and (self.vars is None or self.material_parameters is None):
            raise ValueError("Candidate vars and material_parameters are required.")
        if self.mode == "measurement" and self.measurement_id is None:
            raise ValueError("measurement_id is required.")
        return self


class BatchRetryRequest(BaseModel):
    job_ids: list[UUID] | None = None


class BatchReadRequest(BaseModel):
    event_id: int = Field(ge=0)
