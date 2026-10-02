"""Execution identities are independent of either result transport."""
from itertools import combinations

from sqlalchemy import select

from gpstation.db import ExecutionAttempt, Job
from sdk.protocol.execution import gib_to_bytes

IDENTITY_FIELDS = ("launcher_id", "boot_id", "instance_id", "job_id", "attempt_id", "attempt_count", "reservation_id")


def execution_identity(job: Job) -> dict:
    return {name: job.id if name == "job_id" else getattr(job, name) for name in IDENTITY_FIELDS}


async def sync_attempt(db, job: Job) -> None:
    if not job.attempt_id:
        return
    attempt = await db.get(ExecutionAttempt, job.attempt_id)
    if attempt is None:
        attempt = ExecutionAttempt(id=job.attempt_id, job_id=job.id, attempt_count=job.attempt_count)
        db.add(attempt)
    for name in ("launcher_id", "boot_id", "instance_id", "reservation_id", "resources", "allocation", "finished_at", "cleaned_at"):
        setattr(attempt, name, getattr(job, name))
    terminal = job.state in {"succeeded", "failed", "cancelled", "killed"}
    attempt.state = "finished" if terminal else job.execution_phase or job.state
    attempt.result_state = job.state if terminal else None
    attempt.cleanup_state = job.cleanup_state


async def locked_execution(db, value: dict, *, user_id: str | None = None):
    conditions = [Job.id == value.get("job_id")]
    for name in IDENTITY_FIELDS:
        if name != "job_id":
            conditions.append(getattr(Job, name) == value.get(name))
    if user_id is not None:
        conditions.append(Job.user_id == user_id)
    return await db.scalar(select(Job).where(*conditions).with_for_update().execution_options(populate_existing=True))


def requested_resources(request: dict, report: dict, slave_app_id: str, handler_type: str | None = None) -> dict:
    all_defaults = report.get("defaults", {})
    defaults = all_defaults.get(slave_app_id, {}) if any(isinstance(value, dict) for value in all_defaults.values()) else all_defaults
    result = dict(defaults)
    for layer in (all_defaults.get(handler_type, {}), request):
        overrides = {key: value for key, value in layer.items() if value is not None}
        if overrides.get("gpu_count") == 0 and "vram_budget_gb" not in overrides:
            result.pop("vram_budget_gb", None)
        result.update(overrides)
    return result


def gpu_resources_fit(requests: list[dict], report: dict, *, available: bool = True) -> bool:
    """Fit whole jobs onto distinct devices, using whole-lifetime VRAM budgets.

    Combined capacity is a preflight; the launcher still serializes and observes
    actual starts. Old telemetry cannot admit GPU jobs under the new contract.
    """
    devices = []
    for item in report.get("gpu_devices", []):
        if not isinstance(item, dict) or "vram_reserved_bytes" not in item:
            continue  # Protocol-2 telemetry cannot promise budget enforcement.
        total = item.get("total_bytes", 0)
        reserved = item.get("vram_reserved_bytes", 0) if available else 0
        if (type(total) is not int or total <= 0 or type(reserved) is not int
                or reserved < 0 or reserved > total):
            continue
        if available and (item.get("admission_open") is not True or item.get("free_bytes", 0) <= 0):
            continue
        devices.append([total - reserved, total])
    demands = [(value.get("gpu_count", 0), gib_to_bytes(value["vram_budget_gb"])
                if value.get("vram_budget_gb") is not None else None)
               for value in requests if value.get("gpu_count", 0)]
    demands.sort(key=lambda value: (value[0], value[1] is None, value[1] or 0), reverse=True)

    def place(index: int) -> bool:
        if index == len(demands):
            return True
        count, memory = demands[index]
        eligible = [i for i, (remaining, total) in enumerate(devices)
                    if remaining >= (memory if memory is not None else total)]
        for chosen in combinations(eligible, count):
            amounts = {i: memory if memory is not None else devices[i][1] for i in chosen}
            for i, amount in amounts.items():
                devices[i][0] -= amount
            if place(index + 1):
                return True
            for i, amount in amounts.items():
                devices[i][0] += amount
        return False

    return place(0)


def resource_fits(request: dict, report: dict, slave_app_id: str, handler_type: str | None = None,
                  *, resolved: bool = False) -> bool:
    if not report or not report.get("admission_open", False):
        return False
    needed = request if resolved else requested_resources(request, report, slave_app_id, handler_type)
    if resolved and any(type(needed.get(key)) is not int for key in ("cpu_cores", "startup_ram_bytes", "gpu_count")):
        return False
    cpu = needed.get("cpu_cores", 1)
    ram = needed.get("startup_ram_bytes", 1)
    available_ram = max(0, report.get("ram_budget_bytes", 0) - report.get("ram_used_bytes", 0) - report.get("ram_startup_reserved_bytes", 0))
    if cpu > report.get("cpu_total", 0) - report.get("cpu_reserved", 0) or ram > available_ram:
        return False
    return gpu_resources_fit([needed], report)
