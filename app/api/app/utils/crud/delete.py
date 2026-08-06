from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import delete as sa_delete
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from utils.crud.common import CrudSpec, build_scope_clause, normalize_int_ids


async def _reparent_tree_children(
    db: AsyncSession,
    spec: CrudSpec[Any, Any],
    item_ids: list[int],
) -> None:
    parent_field = spec.tree_parent_field
    if parent_field is None:
        return

    parent_column = getattr(spec.model, parent_field)
    deleted_rows = (
        await db.execute(
            select(spec.model.id, parent_column).where(spec.model.id.in_(item_ids))
        )
    ).all()
    parent_by_id = {row.id: getattr(row, parent_field) for row in deleted_rows}
    deleted_ids = set(item_ids)

    child_rows = (
        await db.execute(
            select(spec.model.id, parent_column).where(
                parent_column.in_(item_ids),
                spec.model.id.not_in(item_ids),
            )
        )
    ).all()
    children_by_parent: dict[int | None, list[int]] = defaultdict(list)
    for child in child_rows:
        ancestor_id = getattr(child, parent_field)
        seen: set[int] = set()
        while ancestor_id in deleted_ids:
            if ancestor_id in seen:
                ancestor_id = None
                break
            seen.add(ancestor_id)
            ancestor_id = parent_by_id.get(ancestor_id)
        children_by_parent[ancestor_id].append(child.id)

    for parent_id, child_ids in children_by_parent.items():
        await db.execute(
            update(spec.model)
            .where(spec.model.id.in_(child_ids))
            .values({parent_field: parent_id})
        )


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
        await _reparent_tree_children(db, spec, item_ids)
        await db.execute(sa_delete(spec.model).where(spec.model.id.in_(item_ids)))
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Database constraint violation.",
        ) from error
