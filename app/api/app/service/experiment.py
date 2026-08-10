from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db import Experiment
from models import SaveCodeEntityResponse, SaveExperimentRequest
from utils.crud.common import is_admin_user


def _bundle_hash(bundle: dict[str, Any]) -> str:
    canonical = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def save_experiment(
    db: AsyncSession,
    request: SaveExperimentRequest,
    *,
    user: Any,
) -> SaveCodeEntityResponse:
    source_bundle = request.sourceBundle.model_dump(mode="json")
    if _bundle_hash(source_bundle) != request.bundleHash:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="bundleHash does not match sourceBundle.")

    if request.id is None:
        entity = Experiment(
            user_id=user.id,
            parent_id=None,
            name=request.name.strip(),
            description=request.description,
            source_bundle=source_bundle,
        )
        db.add(entity)
        action: Literal["created", "updated", "forked"] = "created"
        parent_id = None
    else:
        entity = await db.scalar(select(Experiment).where(Experiment.id == request.id).with_for_update())
        if entity is None or (not is_admin_user(user) and entity.user_id != user.id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Experiment not found.")
        if request.baseBundleHash is None or _bundle_hash(entity.source_bundle) != request.baseBundleHash:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The saved source bundle changed before this save.")

        bundle_changed = entity.source_bundle != source_bundle
        structural_change = bundle_changed and request.baseSemanticHash != request.semanticHash
        if not structural_change:
            entity.name = request.name.strip()
            entity.description = request.description
            entity.source_bundle = source_bundle
            entity.code_embedding = None
            action = "updated"
            parent_id = entity.parent_id
        else:
            if request.baseSemanticHash is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="baseSemanticHash is required when the source bundle changes.",
                )
            parent_id = entity.id
            entity = Experiment(
                user_id=entity.user_id,
                parent_id=parent_id,
                name=request.name.strip(),
                description=request.description,
                source_bundle=source_bundle,
            )
            db.add(entity)
            action = "forked"

    await db.flush()
    await db.commit()
    return SaveCodeEntityResponse(id=entity.id, action=action, parentId=parent_id)
