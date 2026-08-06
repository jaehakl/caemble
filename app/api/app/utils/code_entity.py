from __future__ import annotations

import hashlib
from typing import Any, Literal

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import SaveCodeEntityRequest, SaveCodeEntityResponse
from utils.crud.common import is_admin_user


def _code_hash(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()


async def save_code_entity(
    db: AsyncSession,
    model: type[Any],
    request: SaveCodeEntityRequest,
    *,
    user: Any,
) -> SaveCodeEntityResponse:
    if _code_hash(request.code) != request.rawCodeHash:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="rawCodeHash does not match code.")

    if request.id is None:
        entity = model(
            user_id=user.id,
            parent_id=None,
            name=request.name.strip(),
            description=request.description,
            code=request.code,
        )
        db.add(entity)
        action: Literal["created", "updated", "forked"] = "created"
        parent_id = None
    else:
        entity = await db.scalar(select(model).where(model.id == request.id).with_for_update())
        if entity is None or (not is_admin_user(user) and entity.user_id != user.id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{model.__name__} not found.")
        if request.baseRawCodeHash is None or _code_hash(entity.code) != request.baseRawCodeHash:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The saved source changed before this save.")

        if entity.code == request.code or request.baseSemanticHash == request.semanticHash:
            entity.name = request.name.strip()
            entity.description = request.description
            entity.code = request.code
            entity.code_embedding = None
            action = "updated"
            parent_id = entity.parent_id
        else:
            if request.baseSemanticHash is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="baseSemanticHash is required when code changes.",
                )
            parent_id = entity.id
            entity = model(
                user_id=entity.user_id,
                parent_id=parent_id,
                name=request.name.strip(),
                description=request.description,
                code=request.code,
            )
            db.add(entity)
            action = "forked"

    await db.flush()
    await db.commit()
    return SaveCodeEntityResponse(id=entity.id, action=action, parentId=parent_id)
