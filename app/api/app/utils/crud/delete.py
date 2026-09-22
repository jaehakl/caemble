from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from utils.crud.common import CrudSpec, build_scope_clause, normalize_int_ids


async def delete_items(
    db: AsyncSession,
    spec: CrudSpec[Any, Any],
    ids: Iterable[Any],
    *,
    user: Any | None,
) -> None:
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    item_ids = normalize_int_ids(ids, sort=True)
    if not item_ids:
        return

    stmt = select(spec.model.id).where(spec.model.id.in_(item_ids))
    write_clause = build_scope_clause(spec, user, write=True)
    if write_clause is not None:
        stmt = stmt.where(write_clause)
    accessible_ids = set((await db.execute(stmt)).scalars().all())
    missing_ids = [item_id for item_id in item_ids if item_id not in accessible_ids]
    if missing_ids:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Items not found: {missing_ids}.")

    try:
        await db.execute(sa_delete(spec.model).where(spec.model.id.in_(item_ids)))
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Database constraint violation.",
        ) from error
