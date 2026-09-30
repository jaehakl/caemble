"""Read-only protections for resources retained or controlled by a Optimization."""
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select

from gpstation.db import Job
from optimization.db import StageSubmission, Optimization, Trial


async def require_unreferenced_experiments(db, experiment_ids: list[int]) -> None:
    if await db.scalar(select(Optimization.id).where(Optimization.experiment_id.in_(experiment_ids)).limit(1)) is not None:
        raise HTTPException(409, "Delete retained Optimizations before changing or deleting their Experiment source. Use Save As for a new version.")


async def require_unreferenced_measurements(db, measurement_ids: list[int]) -> None:
    if await db.scalar(select(Trial.id).where(Trial.measurement_id.in_(measurement_ids)).limit(1)) is not None:
        raise HTTPException(409, "Delete the referencing Optimization before deleting its Measurements.")


async def require_unmanaged_execution(db, *, job_id: str | None = None, batch_id: str | None = None,
                                      user_id: str | None = None) -> None:
    query = select(Optimization.id).join(Trial, Trial.optimization_id == Optimization.id).join(StageSubmission, StageSubmission.trial_id == Trial.id)
    query = query.where(StageSubmission.job_id == job_id) if job_id is not None else query.where(StageSubmission.batch_id == batch_id)
    if user_id is not None:
        query = query.where(Optimization.user_id == user_id)
    optimization_id = await db.scalar(query.limit(1))
    if optimization_id is not None:
        raise HTTPException(409, {"code": "optimization_execution_managed", "message": "Control this execution from its Optimization.", "optimization_id": optimization_id})


def unmanaged_execution_clause(*, job_id: Any = None, batch_id: Any = None) -> Any:
    """Exclude Optimization-owned executions before a caller applies pagination."""
    if job_id is not None and batch_id is not None:
        raise ValueError("Provide only one Job or Batch identity column.")
    if job_id is None and batch_id is None:
        job_id = Job.id
    condition = StageSubmission.job_id == job_id if job_id is not None else StageSubmission.batch_id == batch_id
    return ~select(StageSubmission.id).where(condition).exists()
