"""Execution ownership and admission resources, independent of job transports."""
from __future__ import annotations

from decimal import Decimal, ROUND_CEILING
import math

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

EXECUTION_PROTOCOL_VERSION = 3


def gib_to_bytes(value: int | float) -> int:
    """User-facing *_gb fields use GiB; keep byte budgets safe across JS/Python."""
    if type(value) not in (int, float) or value <= 0 or (isinstance(value, float) and not math.isfinite(value)):
        raise ValueError("Memory budgets must be finite positive GiB numbers.")
    result = int((Decimal(str(value)) * (1024 ** 3)).to_integral_value(rounding=ROUND_CEILING))
    if result > 2 ** 53 - 1:
        raise ValueError("Memory budget exceeds the maximum exact byte count.")
    return result


class ExecutionIdentity(BaseModel):
    model_config = ConfigDict(frozen=True)

    launcher_id: str = Field(min_length=1)
    boot_id: str = Field(min_length=1)
    instance_id: str = Field(min_length=1)
    job_id: str = Field(min_length=1)
    attempt_id: str = Field(min_length=1)
    attempt_count: int = Field(strict=True, ge=1)
    reservation_id: str = Field(min_length=1)


class ResourceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cpu_cores: int | None = Field(default=None, strict=True, gt=0)
    startup_ram_bytes: int | None = Field(default=None, strict=True, gt=0)
    gpu_count: int | None = Field(default=None, strict=True, ge=0)
    vram_budget_gb: float | None = Field(default=None, strict=True, gt=0, allow_inf_nan=False)

    @model_validator(mode="before")
    @classmethod
    def reject_legacy_budget(cls, value):
        if isinstance(value, dict) and ("gpu_memory_bytes" in value or "gpu_memory_gb" in value):
            raise ValueError("Use vram_budget_gb in GiB instead of gpu_memory_bytes/gpu_memory_gb (bytes / 1024**3).")
        return value

    @field_validator("vram_budget_gb")
    @classmethod
    def validate_budget(cls, value):
        if value is not None:
            gib_to_bytes(value)
        return value

    @model_validator(mode="after")
    def validate_gpu_request(self):
        if self.gpu_count == 0 and self.vram_budget_gb is not None:
            raise ValueError("A CPU-only request cannot reserve GPU memory.")
        return self


class ResourceAllocation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    cpu_ids: list[int] = Field(min_length=1)
    cpu_cores: int = Field(strict=True, gt=0)
    startup_ram_bytes: int = Field(strict=True, gt=0)
    ram_available_bytes: int = Field(strict=True, ge=0)
    gpu_devices: list[str] = Field(default_factory=list)
    vram_budget_bytes: dict[str, int] = Field(default_factory=dict)

    @field_validator("vram_budget_bytes", mode="before")
    @classmethod
    def validate_budgets(cls, value):
        if not isinstance(value, dict) or any(type(amount) is not int or not 0 < amount <= 2**53 - 1
                                               for amount in value.values()):
            raise ValueError("Each GPU budget must be a positive exact integer byte count.")
        return value

    @model_validator(mode="after")
    def validate_devices(self):
        if any(type(cpu) is not int or cpu < 0 for cpu in self.cpu_ids):
            raise ValueError("CPU identifiers must be nonnegative integers.")
        if len(set(self.cpu_ids)) != len(self.cpu_ids) or len(self.cpu_ids) != self.cpu_cores:
            raise ValueError("CPU allocation must contain exactly cpu_cores distinct identifiers.")
        if any(not device for device in self.gpu_devices) or len(set(self.gpu_devices)) != len(self.gpu_devices):
            raise ValueError("GPU allocation must contain distinct device identifiers.")
        if set(self.vram_budget_bytes) != set(self.gpu_devices):
            raise ValueError("GPU budgets must cover exactly the allocated devices.")
        return self
