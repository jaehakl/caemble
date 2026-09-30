"""Coordinate Experiment content, thumbnails and preflight promotion atomically."""
from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gpstation.service.state import utcnow
from simulation.db import Experiment, ExperimentSaveReceipt, ExperimentThumbnail
from simulation.schemas import SaveExperimentRequest
from simulation.services.assets import promote_preflight, thumbnail_bytes
from simulation.services.experiments import derived_counts, persist_experiment
from simulation.services.source_bundle import require_experiment_source_bundle
from storage.db import StorageObject


async def save_experiment(
    db: AsyncSession,
    request: SaveExperimentRequest,
    *,
    user: Any,
) -> dict[str, Any]:
    try:
        require_experiment_source_bundle(request.sourceBundle.model_dump(mode="json"))
        if request.requestId or request.thumbnail is not None or request.preflightBatchId:
            return await _save_with_assets(db, request, user)
        return await persist_experiment(db, request, user=user)
    except Exception:
        await db.rollback()
        raise


async def _save_with_assets(db, request, user):
    image = thumbnail_bytes(request.thumbnail)
    copies = []
    try:
        request_id = str(UUID(request.requestId)) if request.requestId else None
        payload_hash = hashlib.sha256(json.dumps(request.model_dump(), sort_keys=True).encode()).hexdigest()
        if request_id:
            # One transaction at a time per request, without reversing owner/row locks.
            lock_key = int.from_bytes(hashlib.sha256(f"{user.id}:{request_id}".encode()).digest()[:8], "big", signed=True)
            await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_key})
            receipt = await db.get(ExperimentSaveReceipt, (user.id, request_id))
            if receipt:
                if receipt.payload_hash != payload_hash:
                    raise HTTPException(409, "같은 저장 요청 ID에 다른 내용을 사용할 수 없습니다.")
                result = receipt.response
                await db.commit()
                return result
        result = await persist_experiment(db, request, user=user, commit=False)
        experiment = await db.get(Experiment, result["id"])
        if image is not None:
            thumbnail = await db.get(ExperimentThumbnail, experiment.id)
            if thumbnail is None:
                thumbnail = ExperimentThumbnail(experiment_id=experiment.id)
                db.add(thumbnail)
            thumbnail.data = image
            thumbnail.sha256 = hashlib.sha256(image).hexdigest()
            experiment.thumbnail_url = f"/experiment/{experiment.id}/thumbnail?v={thumbnail.sha256}"
        if request.preflightBatchId:
            result["measurementId"] = await promote_preflight(db, request.preflightBatchId, experiment, user, copies)
        else:
            result["measurementId"] = None
        await db.flush()
        result["thumbnail_url"] = experiment.thumbnail_url
        result["derivedCounts"] = (await derived_counts(db, [experiment.id]))[experiment.id]
        result["sourceLocked"] = result["derivedCounts"]["measurements"] > 0
        if request_id:
            db.add(ExperimentSaveReceipt(user_id=user.id, request_id=request_id, payload_hash=payload_hash, response=result))
        await db.commit()
        return result
    except Exception:
        await db.rollback()
        if copies:
            # A separate transaction leaves durable tombstones even when S3 removal
            # fails. No permanent result ever references these rolled-back copies.
            async with AsyncSession(db.bind) as cleanup:
                for copy in copies:
                    cleanup.add(StorageObject(**copy, purpose="measurement", ready=False, bound=False,
                        deleting=True, updated_at=utcnow() - timedelta(hours=25)))
                await cleanup.commit()
        raise
