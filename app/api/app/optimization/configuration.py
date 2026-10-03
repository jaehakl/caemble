"""Versioned search configuration shared by request validation and saved runs."""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator


class CoordinateConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    initial_step: float = Field(default=0.25, strict=True, gt=0, le=1)
    min_step: float = Field(default=0.001, strict=True, gt=0, le=1)

    @model_validator(mode="after")
    def validate_steps(self):
        if self.min_step > self.initial_step:
            raise ValueError("min_step must not exceed initial_step.")
        return self


class RandomConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    seed: int = Field(default=0, strict=True, ge=0, le=0xffffffff)
    candidates_per_round: int = Field(default=8, strict=True, ge=1, le=32)


class CoordinateAlgorithm(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Literal["coordinate"] = "coordinate"
    version: int = Field(default=1, strict=True, ge=1, le=1)
    config: CoordinateConfig = Field(default_factory=CoordinateConfig)


class RandomAlgorithm(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Literal["random"] = "random"
    version: int = Field(default=1, strict=True, ge=1, le=1)
    config: RandomConfig = Field(default_factory=RandomConfig)


OptimizationAlgorithm = Annotated[CoordinateAlgorithm | RandomAlgorithm, Field(discriminator="id")]
ALGORITHM_CONFIG = TypeAdapter(OptimizationAlgorithm)


class VerificationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")


class VerificationPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Literal["best_predicted_maximin"] = "best_predicted_maximin"
    version: int = Field(default=1, strict=True, ge=1, le=1)
    config: VerificationConfig = Field(default_factory=VerificationConfig)


def saved_algorithm(settings):
    """Old saved settings keep their coordinate steps and evaluation identities."""
    definition = settings.get("algorithm")
    if definition is None:
        definition = {"id": "coordinate", "config": {
            "initial_step": settings.get("initial_step", 0.25),
            "min_step": settings.get("min_step", 0.001),
        }}
    return ALGORITHM_CONFIG.validate_python(definition).model_dump()
