"""Launcher-local admission: explicit CPU/GPU reservations and observed RAM."""
from __future__ import annotations

import asyncio
import csv
import math
import os
import shutil
import subprocess
import time
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psutil
from pydantic import BaseModel, Field, ConfigDict, model_validator

GIB = 1024 ** 3
SAMPLE_INTERVAL = 1.0
METRIC_MAX_AGE = 3.0


class ResourcePolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cpu_cores: int | None = Field(default=None, gt=0)
    ram_budget_bytes: int | None = Field(default=None, gt=0)
    startup_ram_bytes: int = Field(default=GIB, gt=0)
    sample_interval_seconds: float = Field(default=SAMPLE_INTERVAL, gt=0)
    metrics_max_age_seconds: float = Field(default=METRIC_MAX_AGE, gt=0)
    ram_growth_headroom_bytes: int | None = Field(default=None, ge=0)
    system_ram_headroom_bytes: int | None = Field(default=None, ge=0)
    gpu_devices: list[str] | None = None
    defaults: dict[str, dict[str, int]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_observation_timing(self) -> ResourcePolicy:
        if self.metrics_max_age_seconds < self.sample_interval_seconds:
            raise ValueError("metrics_max_age_seconds must be at least sample_interval_seconds")
        return self

    @classmethod
    def load(cls, path: Path, legacy_cpu_budget: int | None = None) -> ResourcePolicy:
        value = tomllib.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if legacy_cpu_budget is not None and "cpu_cores" not in value:
            value["cpu_cores"] = legacy_cpu_budget
        return cls.model_validate(value)


@dataclass
class Reservation:
    allocation: dict[str, Any]
    rss: int = 0
    running: bool = False
    running_samples: int = 0

    @property
    def unobserved_bytes(self) -> int:
        if self.running_samples >= 2:
            return 0
        return max(0, self.allocation["startup_ram_bytes"] - self.rss)


def discover_gpus() -> list[dict[str, Any]]:
    executable = shutil.which("nvidia-smi")
    if executable is None:
        return []
    result = subprocess.run(
        [executable, "--query-gpu=uuid,memory.total,memory.free", "--format=csv,noheader,nounits"],
        capture_output=True, text=True, encoding="utf-8", timeout=2, check=True,
        **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
    )
    return [{"uuid": row[0].strip(), "total_bytes": int(row[1]) * 1024 ** 2,
             "free_bytes": int(row[2]) * 1024 ** 2} for row in csv.reader(result.stdout.splitlines()) if row]


class ResourceLedger:
    def __init__(self, policy: ResourcePolicy, *, cpu_ids: list[int] | None = None,
                 total_ram: int | None = None) -> None:
        self.lock = asyncio.Lock()
        self.policy = policy
        available = cpu_ids if cpu_ids is not None else psutil.Process().cpu_affinity()
        count = policy.cpu_cores or max(1, len(available) // 2)
        if count > len(available):
            raise ValueError("CPU budget exceeds the launcher's available affinity")
        self.cpu_ids = available[:count]
        physical = total_ram if total_ram is not None else psutil.virtual_memory().total
        self.ram_budget = policy.ram_budget_bytes or physical // 2
        self.growth_headroom = policy.ram_growth_headroom_bytes if policy.ram_growth_headroom_bytes is not None else max(GIB, math.ceil(self.ram_budget / 10))
        self.system_headroom = policy.system_ram_headroom_bytes if policy.system_ram_headroom_bytes is not None else max(2 * GIB, math.ceil(physical / 10))
        if self.ram_budget <= self.growth_headroom + policy.startup_ram_bytes:
            raise ValueError("RAM budget must exceed startup allowance plus growth headroom")
        self.reservations: dict[str, Reservation] = {}
        self.revision = 0
        self.sampled_at = 0.0
        self.metrics_complete = False
        self.launcher_rss = 0
        self.available_ram = 0
        self.gpus: list[dict[str, Any]] = []
        self.gpu_metrics_complete = False

    def defaults(self, app_id: str, handler_type: str | None = None) -> dict[str, int]:
        defaults = {"cpu_cores": min(4, len(self.cpu_ids)), "startup_ram_bytes": self.policy.startup_ram_bytes,
                    "gpu_count": 0, "gpu_memory_bytes": 0}
        for key in (app_id, handler_type):
            layer = self.policy.defaults.get(key, {}) if key else {}
            defaults.update(layer)
            if layer.get("gpu_count") == 0 and "gpu_memory_bytes" not in layer:
                defaults["gpu_memory_bytes"] = 0
        return defaults

    def sample(self, rss: dict[str, int], *, launcher_rss: int, available_ram: int,
               gpus: list[dict[str, Any]] | None = None, complete: bool = True,
               now: float | None = None) -> None:
        self.launcher_rss, self.available_ram = launcher_rss, available_ram
        self.metrics_complete = complete
        sampled_at = time.monotonic() if now is None else now
        for instance_id, reservation in self.reservations.items():
            if instance_id in rss:
                reservation.rss = rss[instance_id]
                if reservation.running and complete and sampled_at > self.sampled_at:
                    reservation.running_samples += 1
        self.gpu_metrics_complete = gpus is not None
        if gpus is not None:
            selected = self.policy.gpu_devices
            if selected is None and "CUDA_VISIBLE_DEVICES" in os.environ:
                selectors = [value.strip() for value in os.environ["CUDA_VISIBLE_DEVICES"].split(",") if value.strip()]
                selected = [gpu["uuid"] for index, gpu in enumerate(gpus)
                            if any(selector == str(index) or gpu["uuid"].startswith(selector) for selector in selectors)]
            self.gpus = [gpu for gpu in gpus if selected is None or gpu["uuid"] in selected]
        self.sampled_at = sampled_at
        self.revision += 1

    def reserve(self, instance_id: str, app_id: str, request: dict[str, Any], handler_type: str | None = None) -> tuple[dict[str, Any] | None, str | None]:
        # Caller holds lock, covering validation, mutation, and duplicate detection.
        if instance_id in self.reservations:
            return self.reservations[instance_id].allocation, None
        values = self.defaults(app_id, handler_type)
        explicit = {key: value for key, value in request.items() if value is not None}
        values.update(explicit)
        if explicit.get("gpu_count") == 0 and "gpu_memory_bytes" not in explicit:
            values["gpu_memory_bytes"] = 0
        if set(values) - {"cpu_cores", "startup_ram_bytes", "gpu_count", "gpu_memory_bytes"}:
            return None, "invalid_resources"
        if any(isinstance(value, bool) or not isinstance(value, int) for value in values.values()):
            return None, "invalid_resources"
        cpu, startup, gpu_count, gpu_memory = (values[key] for key in ("cpu_cores", "startup_ram_bytes", "gpu_count", "gpu_memory_bytes"))
        if cpu < 1 or startup < 1 or gpu_count < 0 or gpu_memory < 0 or (gpu_count == 0 and gpu_memory):
            return None, "invalid_resources"
        if cpu > len(self.cpu_ids) or startup + self.growth_headroom > self.ram_budget:
            return None, "request_exceeds_capacity"
        if not self.metrics_complete or time.monotonic() - self.sampled_at > self.policy.metrics_max_age_seconds:
            return None, "metrics_stale"
        used_cpus = {cpu_id for item in self.reservations.values() for cpu_id in item.allocation["cpu_ids"]}
        free_cpus = [cpu_id for cpu_id in self.cpu_ids if cpu_id not in used_cpus]
        if len(free_cpus) < cpu:
            return None, "cpu_unavailable"
        used_ram = self.launcher_rss + sum(item.rss for item in self.reservations.values())
        unobserved = sum(item.unobserved_bytes for item in self.reservations.values())
        if (used_ram + unobserved + startup + self.growth_headroom > self.ram_budget
                or self.available_ram < unobserved + startup + self.growth_headroom + self.system_headroom):
            return None, "ram_pressure"
        allocated_gpus = {gpu for item in self.reservations.values() for gpu in item.allocation["gpu_devices"]}
        if gpu_count and not self.gpu_metrics_complete:
            return None, "gpu_metrics_unavailable"
        eligible = [gpu for gpu in self.gpus if gpu["uuid"] not in allocated_gpus
                    and gpu["free_bytes"] >= gpu_memory + max(GIB, math.ceil(gpu["total_bytes"] / 10))]
        if len(eligible) < gpu_count:
            return None, "gpu_unavailable"
        allocation = {"cpu_ids": free_cpus[:cpu], "cpu_cores": cpu, "startup_ram_bytes": startup,
                      "ram_available_bytes": max(0, min(self.ram_budget - used_ram - unobserved - self.growth_headroom,
                                                        self.available_ram - self.system_headroom - self.growth_headroom,
                                                        (self.ram_budget - self.growth_headroom) * cpu // len(self.cpu_ids))),
                      "gpu_devices": [gpu["uuid"] for gpu in eligible[:gpu_count]], "gpu_memory_bytes": gpu_memory}
        self.reservations[instance_id] = Reservation(allocation)
        self.revision += 1
        return allocation, None

    def release(self, instance_id: str) -> None:
        if self.reservations.pop(instance_id, None) is not None:
            self.revision += 1

    def report(self, app_ids: list[str]) -> dict[str, Any]:
        used = self.launcher_rss + sum(item.rss for item in self.reservations.values())
        startup = sum(item.unobserved_bytes for item in self.reservations.values())
        fresh = self.metrics_complete and time.monotonic() - self.sampled_at <= self.policy.metrics_max_age_seconds
        cpu_reserved = sum(item.allocation["cpu_cores"] for item in self.reservations.values())
        gpu_owners = {gpu: instance for instance, item in self.reservations.items() for gpu in item.allocation["gpu_devices"]}
        return {"revision": self.revision, "admission_open": fresh and cpu_reserved < len(self.cpu_ids)
                and used + startup + self.growth_headroom < self.ram_budget
                and self.available_ram > startup + self.growth_headroom + self.system_headroom,
                "cpu_total": len(self.cpu_ids), "cpu_reserved": cpu_reserved, "ram_budget_bytes": self.ram_budget,
                "ram_used_bytes": used, "ram_startup_reserved_bytes": startup,
                "gpu_devices": [{**gpu, "instance_id": gpu_owners.get(gpu["uuid"])} for gpu in self.gpus],
                "waiting_reason": "metrics_stale" if not fresh else "ram_pressure" if (
                    used + startup + self.growth_headroom >= self.ram_budget
                    or self.available_ram <= startup + self.growth_headroom + self.system_headroom
                ) else "cpu_unavailable" if cpu_reserved == len(self.cpu_ids) else None,
                "defaults": {**{app_id: self.defaults(app_id) for app_id in app_ids},
                             **{key: value for key, value in self.policy.defaults.items() if key not in app_ids}}}
