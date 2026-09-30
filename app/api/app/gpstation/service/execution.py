"""Execution identities are independent of either result transport."""
from sqlalchemy import select

from gpstation.db import ExecutionAttempt, Job

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
        if overrides.get("gpu_count") == 0 and "gpu_memory_bytes" not in overrides:
            result["gpu_memory_bytes"] = 0
        result.update(overrides)
    return result


def resource_fits(request: dict, report: dict, slave_app_id: str, handler_type: str | None = None) -> bool:
    if not report or not report.get("admission_open", False):
        return False
    needed = requested_resources(request, report, slave_app_id, handler_type)
    cpu = needed.get("cpu_cores", 1)
    ram = needed.get("startup_ram_bytes", 1)
    available_ram = max(0, report.get("ram_budget_bytes", 0) - report.get("ram_used_bytes", 0) - report.get("ram_startup_reserved_bytes", 0))
    if cpu > report.get("cpu_total", 0) - report.get("cpu_reserved", 0) or ram > available_ram:
        return False
    gpus = [item for item in report.get("gpu_devices", []) if isinstance(item, dict) and not item.get("instance_id") and not item.get("reserved", False)
            and item.get("free_bytes", 0) >= needed.get("gpu_memory_bytes", 0)]
    if needed.get("gpu_count", 0) > len(gpus):
        return False
    return True
