from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db import Experiment
from models import CodeEntityHistoryResponse, SaveCodeEntityResponse, SaveExperimentRequest
from service.lineage import get_code_entity_history
from utils.crud.common import is_admin_user


def _bundle_hash(bundle: dict[str, Any]) -> str:
    canonical = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def get_experiment_history(
    db: AsyncSession,
    experiment_id: int,
    *,
    user: Any,
) -> CodeEntityHistoryResponse:
    return await get_code_entity_history(db, Experiment, experiment_id, user=user)


async def save_experiment(
    db: AsyncSession,
    request: SaveExperimentRequest,
    *,
    user: Any,
) -> SaveCodeEntityResponse:
    source_bundle = request.sourceBundle.model_dump(mode="json")
    source_hash = _bundle_hash(source_bundle)
    if source_hash != request.bundleHash:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="bundleHash does not match sourceBundle.")

    if request.id is None:
        entity = Experiment(
            user_id=user.id,
            parent_id=None,
            name=request.name.strip(),
            description=request.description,
            source_bundle=source_bundle,
            source_hash=source_hash,
        )
        db.add(entity)
        action: Literal["created", "updated", "forked"] = "created"
        parent_id = None
    else:
        entity = await db.scalar(select(Experiment).where(Experiment.id == request.id).with_for_update())
        if entity is None or (not is_admin_user(user) and entity.user_id != user.id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Experiment not found.")
        if request.baseBundleHash is None or entity.source_hash != request.baseBundleHash:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The saved source bundle changed before this save.")

        bundle_changed = entity.source_bundle != source_bundle
        if not bundle_changed:
            entity.name = request.name.strip()
            entity.description = request.description
            action = "updated"
            parent_id = entity.parent_id
        else:
            parent_id = entity.id
            entity = Experiment(
                user_id=entity.user_id,
                parent_id=parent_id,
                name=request.name.strip(),
                description=request.description,
                source_bundle=source_bundle,
                source_hash=source_hash,
            )
            db.add(entity)
            action = "forked"

    await db.flush()
    await db.commit()
    return SaveCodeEntityResponse(
        id=entity.id,
        action=action,
        parentId=parent_id,
        sourceHash=entity.source_hash,
    )
