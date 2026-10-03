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


class DifferentialEvolutionConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    population_size: int = Field(default=8, strict=True, ge=4, le=32)
    mutation_factor: float = Field(default=0.8, strict=True, gt=0, lt=2)
    crossover_rate: float = Field(default=0.9, strict=True, ge=0, le=1)
    seed: int = Field(default=0, strict=True, ge=0, le=0xffffffff)


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


class DifferentialEvolutionAlgorithm(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Literal["de"] = "de"
    version: int = Field(default=1, strict=True, ge=1, le=1)
    config: DifferentialEvolutionConfig = Field(default_factory=DifferentialEvolutionConfig)


OptimizationAlgorithm = Annotated[
    CoordinateAlgorithm | RandomAlgorithm | DifferentialEvolutionAlgorithm, Field(discriminator="id")]
ALGORITHM_CONFIG = TypeAdapter(OptimizationAlgorithm)


class VerificationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")


class VerificationPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Literal["best_predicted_maximin"] = "best_predicted_maximin"
    version: int = Field(default=1, strict=True, ge=1, le=1)
    config: VerificationConfig = Field(default_factory=VerificationConfig)


class ModelUpdateConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    min_new_measurements: int = Field(default=3, strict=True, gt=0)
    max_updates: int = Field(default=3, strict=True, gt=0)
    update_timeout_seconds: int = Field(default=180, strict=True, gt=0)
    total_timeout_seconds: int = Field(default=540, strict=True, gt=0)


class ModelUpdatePolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Literal["new_solver_results"] = "new_solver_results"
    version: int = Field(default=1, strict=True, ge=1, le=1)
    config: ModelUpdateConfig = Field(default_factory=ModelUpdateConfig)


def saved_algorithm(settings):
    """Old saved settings keep their coordinate steps and evaluation identities."""
    definition = settings.get("algorithm")
    if definition is None:
        definition = {"id": "coordinate", "config": {
            "initial_step": settings.get("initial_step", 0.25),
            "min_step": settings.get("min_step", 0.001),
        }}
    return ALGORITHM_CONFIG.validate_python(definition).model_dump()
