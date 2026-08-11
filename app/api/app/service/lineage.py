from __future__ import annotations

from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from models import CodeEntityHistoryItem, CodeEntityHistoryResponse, UserData
from utils.crud.common import is_admin_user


def _visible_clause(model: type[Any], user: UserData) -> Any | None:
    if is_admin_user(user):
        return None
    return or_(model.user_id.is_(None), model.user_id == user.id)


async def get_code_entity_history(
    db: AsyncSession,
    model: type[Any],
    selected_id: int,
    *,
    user: UserData,
) -> CodeEntityHistoryResponse:
    visible_clause = _visible_clause(model, user)
    current_id = selected_id
    root_id = selected_id
    visited: set[int] = set()

    while True:
        stmt = select(model.id, model.parent_id).where(model.id == current_id)
        if visible_clause is not None:
            stmt = stmt.where(visible_clause)
        current = (await db.execute(stmt)).one_or_none()
        if current is None:
            if current_id == selected_id:
                raise LookupError(f"{model.__name__} not found.")
            break
        if current.id in visited:
            raise RuntimeError(f"{model.__name__} lineage contains a cycle.")
        visited.add(current.id)
        root_id = current.id
        if current.parent_id is None:
            break
        current_id = current.parent_id

    lineage = (
        select(
            model.id,
            model.created_at,
            model.updated_at,
            model.user_id,
            model.parent_id,
            model.name,
            model.description,
        )
        .where(model.id == root_id)
        .cte(f"{model.__tablename__}_lineage", recursive=True)
    )
    children = select(
        model.id,
        model.created_at,
        model.updated_at,
        model.user_id,
        model.parent_id,
        model.name,
        model.description,
    ).join(lineage, model.parent_id == lineage.c.id)
    if visible_clause is not None:
        children = children.where(visible_clause)
    lineage = lineage.union_all(children)

    rows = (
        await db.execute(
            select(lineage).order_by(
                lineage.c.created_at.asc(),
                lineage.c.id.asc(),
            )
        )
    ).all()
    return CodeEntityHistoryResponse(
        selected_id=selected_id,
        root_id=root_id,
        items=[
            CodeEntityHistoryItem(
                id=row.id,
                created_at=row.created_at,
                updated_at=row.updated_at,
                user_id=row.user_id,
                parent_id=row.parent_id,
                name=row.name,
                description=row.description,
            )
            for row in rows
        ],
    )
