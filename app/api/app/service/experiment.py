from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Literal

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from db import Experiment, ExperimentGeometryModule, ExperimentGeometryRoot
from models import (
    CodeEntityHistoryResponse,
    SaveCodeEntityResponse,
    SaveExperimentRequest,
)
from service.geometry import validate_experiment_tsx_imports, validate_snapshot
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
    bundle = request.sourceBundle
    geometry_snapshot = bundle.geometrySnapshot
    snapshot_was_supplied = "geometrySnapshot" in bundle.model_fields_set
    if (bundle.formatVersion == 3 and geometry_snapshot is None) or (
        bundle.formatVersion == 2 and snapshot_was_supplied
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "geometrySnapshot is required for formatVersion 3 and is not allowed "
                "for formatVersion 2."
            ),
        )

    allowed_task = re.compile(r"^tasks/[A-Za-z][A-Za-z0-9_-]*\.tsx$")
    invalid_paths = [
        path
        for path in bundle.files
        if path not in {"experiment.tsx", "simulate.py"}
        and allowed_task.fullmatch(path) is None
    ]
    if invalid_paths:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Experiment source file path is not allowed: {invalid_paths[0]}",
        )
    if "experiment.tsx" not in bundle.files or "simulate.py" not in bundle.files:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Experiment source bundle requires experiment.tsx and simulate.py.",
        )
    if not any(allowed_task.fullmatch(path) for path in bundle.files):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Experiment source bundle requires at least one Task file.",
        )
    total_bytes = 0
    for path, source in bundle.files.items():
        try:
            source_bytes = len(source.encode("utf-8"))
        except UnicodeEncodeError as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Experiment source {path} must contain valid UTF-8 text.",
            ) from error
        if source_bytes > 1024 * 1024:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Experiment source {path} exceeds 1 MiB.",
            )
        total_bytes += source_bytes
    if total_bytes > 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Experiment source bundle exceeds 1 MiB.",
        )
    if not bundle.files["experiment.tsx"].strip() or not bundle.files["simulate.py"].strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Experiment program sources must not be empty.",
        )

    source_bundle = request.sourceBundle.model_dump(mode="json")
    source_hash = _bundle_hash(source_bundle)
    if source_hash != request.bundleHash:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="bundleHash does not match sourceBundle.")

    for path, source in request.sourceBundle.files.items():
        if path.endswith(".tsx"):
            validate_experiment_tsx_imports(source)

    existing = None
    if request.id is not None:
        existing = await db.scalar(
            select(Experiment).where(Experiment.id == request.id).with_for_update()
        )
        if existing is None or (not is_admin_user(user) and existing.user_id != user.id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Experiment not found.")
        if request.baseBundleHash is None or existing.source_hash != request.baseBundleHash:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The saved source bundle changed before this save.",
            )
        if existing.source_bundle.get("formatVersion") == 3 and source_bundle["formatVersion"] == 2:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Experiment source bundles cannot be downgraded from formatVersion 3 to 2.",
            )

    owner_id = existing.user_id if existing is not None else user.id
    if geometry_snapshot is not None:
        if owner_id is None and geometry_snapshot.roots:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A public Experiment cannot reference user-owned Geometry modules.",
            )
        await validate_snapshot(
            db,
            geometry_snapshot,
            owner_id=owner_id,
        )

    if existing is None:
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
        entity = existing

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
    await db.execute(
        delete(ExperimentGeometryRoot).where(ExperimentGeometryRoot.experiment_id == entity.id)
    )
    await db.execute(
        delete(ExperimentGeometryModule).where(ExperimentGeometryModule.experiment_id == entity.id)
    )
    if geometry_snapshot is not None:
        db.add_all(
            ExperimentGeometryRoot(
                experiment_id=entity.id,
                alias=root.alias,
                geometry_version_id=root.geometryVersionId,
            )
            for root in geometry_snapshot.roots
        )
        db.add_all(
            ExperimentGeometryModule(
                experiment_id=entity.id,
                geometry_version_id=module.geometryVersionId,
            )
            for module in geometry_snapshot.modules
        )
    await db.commit()
    return SaveCodeEntityResponse(
        id=entity.id,
        action=action,
        parentId=parent_id,
        sourceHash=entity.source_hash,
    )
