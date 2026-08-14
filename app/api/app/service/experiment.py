from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Literal

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from db import Experiment, ExperimentGeometryImport, ExperimentGeometryModule
from models import (
    CodeEntityHistoryResponse,
    SaveCodeEntityResponse,
    SaveExperimentRequest,
)
from service.geometry import (
    analyze_geometry_source,
    build_snapshot_from_entry_source,
    validate_experiment_tsx_imports,
)
from service.material import validate_material_source_imports
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

    allowed_task = re.compile(r"^tasks/[A-Za-z][A-Za-z0-9_-]*\.tsx$")
    invalid_paths = [
        path
        for path in bundle.files
        if path not in {"experiment.tsx", "geometry.tsx", "material.tsx", "simulate.py"}
        and allowed_task.fullmatch(path) is None
    ]
    if invalid_paths:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Experiment source file path is not allowed: {invalid_paths[0]}",
        )
    if not {"experiment.tsx", "geometry.tsx", "material.tsx", "simulate.py"}.issubset(
        bundle.files
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "Experiment source bundle requires experiment.tsx, geometry.tsx, "
                "material.tsx, and simulate.py."
            ),
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

    try:
        analyze_geometry_source(bundle.files["geometry.tsx"], allow_empty=True)
        validate_experiment_tsx_imports(bundle.files["experiment.tsx"], path="experiment.tsx")
        validate_material_source_imports(bundle.files["material.tsx"])
        for path, source in bundle.files.items():
            if allowed_task.fullmatch(path):
                validate_experiment_tsx_imports(source, path=path)
    except HTTPException as error:
        if error.status_code == status.HTTP_400_BAD_REQUEST:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=error.detail,
            ) from error
        raise

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
    owner_id = existing.user_id if existing is not None else user.id
    expected_snapshot = await build_snapshot_from_entry_source(
        db,
        bundle.files["geometry.tsx"],
        owner_id=owner_id,
    )
    if expected_snapshot.model_dump(mode="json") != geometry_snapshot.model_dump(mode="json"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="geometrySnapshot does not match geometry.tsx and the published Geometry graph.",
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
        delete(ExperimentGeometryImport).where(ExperimentGeometryImport.experiment_id == entity.id)
    )
    await db.execute(
        delete(ExperimentGeometryModule).where(ExperimentGeometryModule.experiment_id == entity.id)
    )
    db.add_all(
        ExperimentGeometryImport(
            experiment_id=entity.id,
            alias=imported.alias,
            export_name=imported.exportName,
            geometry_version_id=imported.geometryVersionId,
        )
        for imported in geometry_snapshot.entryImports
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
