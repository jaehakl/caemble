from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator


class OptimizationAxis(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    name: str = Field(min_length=1)
    indices: list[StrictInt] = Field(default_factory=list)
    min: float | None = Field(default=None, strict=True)
    max: float | None = Field(default=None, strict=True)
    fixed: bool = False

    @model_validator(mode="after")
    def validate_bounds(self):
        if ((self.min is not None and self.max is not None and self.min > self.max)
                or any(index < 0 for index in self.indices)):
            raise ValueError("Axis bounds and Tensor indices must be valid.")
        return self


class OptimizationObjective(BaseModel):
    model_config = ConfigDict(extra="forbid")
    calculation_id: int = Field(strict=True, gt=0)
    direction: Literal["minimize", "maximize"] = "minimize"


class OptimizationConstraint(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    calculation_id: int = Field(strict=True, gt=0)
    minimum: float | None = Field(default=None, strict=True)
    maximum: float | None = Field(default=None, strict=True)

    @model_validator(mode="after")
    def validate_bounds(self):
        if self.minimum is None and self.maximum is None:
            raise ValueError("A constraint needs a lower or upper bound.")
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError("Constraint minimum must not exceed maximum.")
        return self


class OptimizationCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    request_id: UUID
    experiment_id: int = Field(strict=True, gt=0)
    source_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    vars_schema: dict[str, Any]
    initial_vars: dict[str, Any]
    axes: list[OptimizationAxis] | None = None
    objective: OptimizationObjective
    constraints: list[OptimizationConstraint] = Field(default_factory=list)
    max_trials: int = Field(default=20, strict=True, ge=1)
    max_parallel: int = Field(default=2, strict=True, ge=1)
    name: str | None = Field(default=None, min_length=1)


class OptimizationRetryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
