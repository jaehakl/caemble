from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db import Experiment, ExperimentDemo
from utils.crud.common import is_admin_user


async def experiment_is_demo(db: AsyncSession, experiment_id: int) -> bool:
    return (
        await db.scalar(
            select(ExperimentDemo.experiment_id).where(ExperimentDemo.experiment_id == experiment_id)
        )
    ) is not None


async def require_experiment_read(
    db: AsyncSession,
    experiment_id: int,
    user: Any | None,
) -> Experiment:
    experiment = await db.get(Experiment, experiment_id)
    if experiment is not None and (
        is_admin_user(user)
        or (user is not None and experiment.user_id == user.id)
        or await experiment_is_demo(db, experiment_id)
    ):
        return experiment
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Experiment not found.")


async def require_experiment_write(
    db: AsyncSession,
    experiment_id: int,
    user: Any,
) -> Experiment:
    experiment = await db.get(Experiment, experiment_id)
    if experiment is not None and (is_admin_user(user) or (user is not None and experiment.user_id == user.id)):
        return experiment
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Experiment not found.")
