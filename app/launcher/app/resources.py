"""Launcher-local admission: CPU reservations and observed RAM/VRAM."""
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
from sdk.protocol.execution import ResourceRequest, gib_to_bytes

GIB = 1024 ** 3
SAMPLE_INTERVAL = 1.0
METRIC_MAX_AGE = 3.0


class ResourcePolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cpu_cores: int | None = Field(default=None, gt=0)
    ram_budget_gb: float | None = Field(default=None, strict=True, gt=0, allow_inf_nan=False)
    startup_ram_bytes: int = Field(default=GIB, gt=0)
    sample_interval_seconds: float = Field(default=SAMPLE_INTERVAL, gt=0)
    metrics_max_age_seconds: float = Field(default=METRIC_MAX_AGE, gt=0)
    ram_growth_headroom_bytes: int | None = Field(default=None, ge=0)
    system_ram_headroom_bytes: int | None = Field(default=None, ge=0)
    gpu_devices: list[str] | None = None
    gpu_count: int = Field(default=1, strict=True, ge=0)
    defaults: dict[str, dict[str, Any]] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def reject_legacy_ram(cls, value):
        if isinstance(value, dict) and "ram_budget_bytes" in value:
            raise ValueError("Use ram_budget_gb in GiB instead of ram_budget_bytes (bytes / 1024**3).")
        return value

    @model_validator(mode="after")
    def validate_observation_timing(self) -> ResourcePolicy:
        if self.metrics_max_age_seconds < self.sample_interval_seconds:
            raise ValueError("metrics_max_age_seconds must be at least sample_interval_seconds")
        if self.ram_budget_gb is not None:
            gib_to_bytes(self.ram_budget_gb)
        self.defaults = {key: ResourceRequest.model_validate(value).model_dump(exclude_none=True)
                         for key, value in self.defaults.items()}
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


@dataclass
class GpuObservation:
    changed_at: float = 0.0
    sampled_at: float = 0.0
    free_bytes: int | None = None
    stable_samples: int = 0


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
        self.ram_budget = gib_to_bytes(policy.ram_budget_gb) if policy.ram_budget_gb is not None else physical // 2
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
        self.gpu_process_metrics_complete = False
        self.gpu_observations: dict[str, GpuObservation] = {}

    def defaults(self, app_id: str, handler_type: str | None = None) -> dict[str, Any]:
        defaults = {"cpu_cores": min(4, len(self.cpu_ids)), "startup_ram_bytes": self.policy.startup_ram_bytes,
                    "gpu_count": self.policy.gpu_count}
        for key in (app_id, handler_type):
            layer = self.policy.defaults.get(key, {}) if key else {}
            defaults.update(layer)
            if layer.get("gpu_count") == 0 and "vram_budget_gb" not in layer:
                defaults.pop("vram_budget_gb", None)
        return defaults

    def selected_gpus(self, gpus: list[dict[str, Any]]) -> list[dict[str, Any]]:
        selected = self.policy.gpu_devices
        if selected is None and "CUDA_VISIBLE_DEVICES" in os.environ:
            selectors = [value.strip() for value in os.environ["CUDA_VISIBLE_DEVICES"].split(",") if value.strip()]
            selected = [gpu["uuid"] for index, gpu in enumerate(gpus)
                        if any(selector == str(index) or gpu["uuid"].startswith(selector) for selector in selectors)]
        return [gpu for gpu in gpus if selected is None or gpu["uuid"] in selected]

    def sample(self, rss: dict[str, int], *, launcher_rss: int, available_ram: int,
               gpus: list[dict[str, Any]] | None = None, complete: bool = True,
               now: float | None = None, gpu_sample_started_at: float | None = None,
               gpu_process_metrics_complete: bool = False) -> None:
        self.launcher_rss, self.available_ram = launcher_rss, available_ram
        self.metrics_complete = complete
        sampled_at = time.monotonic() if now is None else now
        for instance_id, reservation in self.reservations.items():
            if instance_id in rss:
                reservation.rss = rss[instance_id]
                if reservation.running and complete and sampled_at > self.sampled_at:
                    reservation.running_samples += 1
        gpu_stamp = sampled_at if gpu_sample_started_at is None else gpu_sample_started_at
        self.gpu_process_metrics_complete = gpu_process_metrics_complete
        self.gpu_metrics_complete = gpus is not None and all(
            isinstance(gpu, dict) and isinstance(gpu.get("uuid"), str) and gpu["uuid"]
            and type(gpu.get("total_bytes")) is int and type(gpu.get("free_bytes")) is int
            and 0 <= gpu["free_bytes"] <= gpu["total_bytes"] and gpu["total_bytes"] > 0
            for gpu in gpus)
        if self.gpu_metrics_complete:
            self.gpu_metrics_complete = len({gpu["uuid"] for gpu in gpus}) == len(gpus)
        if self.gpu_metrics_complete:
            self.gpus = self.selected_gpus(gpus)
            present = {gpu["uuid"] for gpu in self.gpus}
            for device in self.gpu_observations.keys() - present:
                changed_at = max(gpu_stamp, self.gpu_observations[device].changed_at)
                self.gpu_observations[device] = GpuObservation(changed_at=changed_at)
            for gpu in self.gpus:
                observation = self.gpu_observations.setdefault(gpu["uuid"], GpuObservation())
                # A query begun before reserve/running/cleanup cannot observe that transition.
                if gpu_stamp <= max(observation.changed_at, observation.sampled_at):
                    continue
                previous = observation.free_bytes
                if (not gpu_process_metrics_complete
                        or gpu_stamp - observation.sampled_at > self.policy.metrics_max_age_seconds):
                    previous = None
                observation.stable_samples = (min(2, observation.stable_samples + 1)
                    if previous is not None and gpu["free_bytes"] >= previous else 0)
                observation.free_bytes = gpu["free_bytes"] if gpu_process_metrics_complete else None
                observation.sampled_at = gpu_stamp
        else:
            for device in self.gpu_observations:
                changed_at = max(gpu_stamp, self.gpu_observations[device].changed_at)
                self.gpu_observations[device] = GpuObservation(changed_at=changed_at)
        self.sampled_at = sampled_at
        self.revision += 1

    def reset_gpu_observation(self, devices: list[str]) -> None:
        changed_at = time.monotonic()
        for device in devices:
            self.gpu_observations[device] = GpuObservation(changed_at=changed_at)

    def mark_running(self, instance_id: str) -> None:
        reservation = self.reservations[instance_id]
        if not reservation.running:
            reservation.running = True
            self.reset_gpu_observation(reservation.allocation["gpu_devices"])
            self.revision += 1

    def gpu_report(self) -> list[dict[str, Any]]:
        result = []
        now = time.monotonic()
        for gpu in self.gpus:
            owners = [instance for instance, item in self.reservations.items()
                      if gpu["uuid"] in item.allocation["gpu_devices"]]
            observation = self.gpu_observations.get(gpu["uuid"], GpuObservation())
            free_bytes = observation.free_bytes if observation.free_bytes is not None else gpu["free_bytes"]
            reserved = sum(self.reservations[owner].allocation["vram_budget_bytes"][gpu["uuid"]]
                           for owner in owners)
            reason = None
            if (not self.gpu_metrics_complete or not self.gpu_process_metrics_complete or observation.free_bytes is None
                    or now - observation.sampled_at > self.policy.metrics_max_age_seconds):
                reason = "gpu_metrics_unavailable"
            elif reserved >= gpu["total_bytes"]:
                reason = "gpu_budget_unavailable"
            elif free_bytes <= 0:
                reason = "gpu_memory_pressure"
            elif owners and (any(not self.reservations[owner].running for owner in owners)
                             or observation.stable_samples < 2):
                reason = "gpu_observing"
            result.append({**gpu, "free_bytes": free_bytes, "instance_id": owners[0] if owners else None,
                           "instance_ids": owners, "job_count": len(owners), "vram_reserved_bytes": reserved,
                           "admission_open": reason is None,
                           "waiting_reason": reason})
        return result

    def reserve(self, instance_id: str, app_id: str, request: dict[str, Any], handler_type: str | None = None) -> tuple[dict[str, Any] | None, str | None]:
        # Caller holds lock, covering validation, mutation, and duplicate detection.
        if instance_id in self.reservations:
            return self.reservations[instance_id].allocation, None
        values = self.defaults(app_id, handler_type)
        explicit = {key: value for key, value in request.items() if value is not None}
        values.update(explicit)
        if explicit.get("gpu_count") == 0 and "vram_budget_gb" not in explicit:
            values.pop("vram_budget_gb", None)
        try:
            validated = ResourceRequest.model_validate(values)
        except ValueError:
            return None, "invalid_resources"
        cpu, startup, gpu_count = validated.cpu_cores, validated.startup_ram_bytes, validated.gpu_count
        gpu_memory = gib_to_bytes(validated.vram_budget_gb) if validated.vram_budget_gb is not None else None
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
        if gpu_count and (not self.gpu_metrics_complete or not self.gpu_process_metrics_complete):
            return None, "gpu_metrics_unavailable"
        eligible = [gpu for gpu in self.gpu_report() if gpu["admission_open"]
                    and gpu["total_bytes"] - gpu["vram_reserved_bytes"] >= (gpu_memory or gpu["total_bytes"])]
        if len(eligible) < gpu_count:
            return None, "gpu_unavailable"
        allocation = {"cpu_ids": free_cpus[:cpu], "cpu_cores": cpu, "startup_ram_bytes": startup,
                      "ram_available_bytes": max(0, min(self.ram_budget - used_ram - unobserved - self.growth_headroom,
                                                        self.available_ram - self.system_headroom - self.growth_headroom,
                                                        (self.ram_budget - self.growth_headroom) * cpu // len(self.cpu_ids))),
                      "gpu_devices": [gpu["uuid"] for gpu in eligible[:gpu_count]],
                      "vram_budget_bytes": {gpu["uuid"]: gpu_memory or gpu["total_bytes"] for gpu in eligible[:gpu_count]}}
        self.reservations[instance_id] = Reservation(allocation)
        self.reset_gpu_observation(allocation["gpu_devices"])
        self.revision += 1
        return allocation, None

    def release(self, instance_id: str) -> None:
        reservation = self.reservations.pop(instance_id, None)
        if reservation is not None:
            self.reset_gpu_observation(reservation.allocation["gpu_devices"])
            self.revision += 1

    def report(self, app_ids: list[str]) -> dict[str, Any]:
        used = self.launcher_rss + sum(item.rss for item in self.reservations.values())
        startup = sum(item.unobserved_bytes for item in self.reservations.values())
        fresh = self.metrics_complete and time.monotonic() - self.sampled_at <= self.policy.metrics_max_age_seconds
        cpu_reserved = sum(item.allocation["cpu_cores"] for item in self.reservations.values())
        return {"revision": self.revision, "admission_open": fresh and cpu_reserved < len(self.cpu_ids)
                and used + startup + self.growth_headroom < self.ram_budget
                and self.available_ram > startup + self.growth_headroom + self.system_headroom,
                "cpu_total": len(self.cpu_ids), "cpu_reserved": cpu_reserved, "ram_budget_bytes": self.ram_budget,
                "ram_used_bytes": used, "ram_startup_reserved_bytes": startup,
                "gpu_devices": self.gpu_report(),
                "waiting_reason": "metrics_stale" if not fresh else "ram_pressure" if (
                    used + startup + self.growth_headroom >= self.ram_budget
                    or self.available_ram <= startup + self.growth_headroom + self.system_headroom
                ) else "cpu_unavailable" if cpu_reserved == len(self.cpu_ids) else None,
                "defaults": {**{app_id: self.defaults(app_id) for app_id in app_ids},
                             **{key: value for key, value in self.policy.defaults.items() if key not in app_ids}}}
