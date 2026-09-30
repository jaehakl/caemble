"""Execution ownership and admission resources, independent of job transports."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, model_validator

EXECUTION_PROTOCOL_VERSION = 2


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
    gpu_memory_bytes: int | None = Field(default=None, strict=True, ge=0)

    @model_validator(mode="after")
    def validate_gpu_request(self):
        if self.gpu_count == 0 and self.gpu_memory_bytes:
            raise ValueError("A CPU-only request cannot reserve GPU memory.")
        return self


class ResourceAllocation(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    cpu_ids: list[int] = Field(min_length=1)
    cpu_cores: int = Field(strict=True, gt=0)
    startup_ram_bytes: int = Field(strict=True, gt=0)
    ram_available_bytes: int = Field(strict=True, ge=0)
    gpu_devices: list[str] = Field(default_factory=list)
    gpu_memory_bytes: int = Field(default=0, strict=True, ge=0)

    @model_validator(mode="after")
    def validate_devices(self):
        if any(type(cpu) is not int or cpu < 0 for cpu in self.cpu_ids):
            raise ValueError("CPU identifiers must be nonnegative integers.")
        if len(set(self.cpu_ids)) != len(self.cpu_ids) or len(self.cpu_ids) != self.cpu_cores:
            raise ValueError("CPU allocation must contain exactly cpu_cores distinct identifiers.")
        if any(not device for device in self.gpu_devices) or len(set(self.gpu_devices)) != len(self.gpu_devices):
            raise ValueError("GPU allocation must contain distinct device identifiers.")
        if not self.gpu_devices and self.gpu_memory_bytes:
            raise ValueError("A CPU-only allocation cannot reserve GPU memory.")
        return self
