from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable
from typing import Any

from caemble_catalog.experiment_bundle import (
    ExperimentBundleError,
    is_experiment_source_path,
    validate_experiment_module_graph,
)
from fastapi import HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from db import DesignerModel, Experiment, Measurement, PredictorModel, RecordedData
from models import (
    ExperimentDerivedCounts,
    ExperimentSourceBundle,
    SaveExperimentRequest,
    SaveExperimentResponse,
)
from user_auth.db import User, UserRole
from utils.crud.common import is_admin_user, normalize_int_ids


MAX_BUNDLE_FILES = 256
MAX_SOURCE_BYTES = 1024 * 1024
MAX_BUNDLE_BYTES = 1024 * 1024
SEMVER_COMPONENT_MAX = 2_147_483_647
NAMESPACE_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$")
SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
SEMVER_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
REQUIRED_SOURCE_PATHS = frozenset(
    {"experiment.tsx", "geometry.tsx", "material.tsx", "simulate.py"}
)


def _bad(message: Any, *, code: int = status.HTTP_422_UNPROCESSABLE_ENTITY) -> HTTPException:
    return HTTPException(status_code=code, detail=message)


def _bundle_hash(bundle: dict[str, Any]) -> str:
    canonical = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _version_text(experiment: Experiment) -> str:
    return f"{experiment.version_major}.{experiment.version_minor}.{experiment.version_patch}"


def _coordinate(experiment: Experiment) -> str:
    return (
        f"caemble:experiment/{experiment.namespace}/{experiment.repository_slug}/"
        f"{experiment.experiment_key}@{_version_text(experiment)}"
    )


def _parse_version(value: str | None) -> tuple[int, int, int]:
    match = SEMVER_RE.fullmatch(value or "")
    if match is None:
        raise _bad("initialVersion must be a release-only SemVer value.")
    parts = tuple(int(item) for item in match.groups())
    if any(item > SEMVER_COMPONENT_MAX for item in parts):
        raise _bad(f"SemVer components must not exceed {SEMVER_COMPONENT_MAX}.")
    return parts  # type: ignore[return-value]


def _bump_version(experiment: Experiment, bump: str) -> tuple[int, int, int]:
    major, minor, patch = (
        experiment.version_major,
        experiment.version_minor,
        experiment.version_patch,
    )
    if bump == "major":
        major, minor, patch = major + 1, 0, 0
    elif bump == "minor":
        minor, patch = minor + 1, 0
    else:
        patch += 1
    if max(major, minor, patch) > SEMVER_COMPONENT_MAX:
        raise _bad(f"SemVer components must not exceed {SEMVER_COMPONENT_MAX}.")
    return major, minor, patch


def validate_source_bundle(bundle: ExperimentSourceBundle) -> dict[str, Any]:
    files = bundle.files
    if len(files) > MAX_BUNDLE_FILES:
        raise _bad(f"Experiment source bundle may contain at most {MAX_BUNDLE_FILES} files.")
    missing = REQUIRED_SOURCE_PATHS - files.keys()
    if missing:
        raise _bad(f"Experiment source bundle is missing required file: {sorted(missing)[0]}")
    casefold_paths: set[str] = set()
    total_bytes = 0
    for path, source in files.items():
        if not is_experiment_source_path(path):
            raise _bad(f"Experiment source file path is not allowed: {path}")
        folded_path = path.casefold()
        if folded_path in casefold_paths:
            raise _bad(f"Experiment source paths must be case-insensitively unique: {path}")
        casefold_paths.add(folded_path)
        try:
            source_bytes = len(source.encode("utf-8"))
        except UnicodeEncodeError as error:
            raise _bad(f"Experiment source {path} must contain valid UTF-8 text.") from error
        if source_bytes > MAX_SOURCE_BYTES:
            raise _bad(f"Experiment source {path} exceeds 1 MiB.")
        total_bytes += source_bytes
    if total_bytes > MAX_BUNDLE_BYTES:
        raise _bad("Experiment source bundle exceeds 1 MiB.")
    if not files["experiment.tsx"].strip() or not files["simulate.py"].strip():
        raise _bad("Experiment program sources must not be empty.")
    try:
        validate_experiment_module_graph(files)
    except ExperimentBundleError as error:
        raise _bad(str(error)) from error
    return bundle.model_dump(mode="json")


async def change_experiment_namespace(db: AsyncSession, user_id: str, namespace: str) -> User:
    if NAMESPACE_RE.fullmatch(namespace) is None:
        raise _bad("Experiment namespace format is invalid.")
    if namespace == "caemble":
        raise _bad(
            "The caemble namespace is reserved for Examples.",
            code=status.HTTP_409_CONFLICT,
        )
    user = await db.scalar(
        select(User)
        .options(selectinload(User.user_roles).selectinload(UserRole.role))
        .where(User.id == user_id)
        .with_for_update()
    )
    if user is None:
        raise _bad("User inactive", code=status.HTTP_401_UNAUTHORIZED)
    if user.experiment_namespace == namespace:
        return user
    reserved = await db.scalar(
        select(func.count()).select_from(Experiment).where(
            Experiment.namespace == namespace,
            Experiment.user_id != user_id,
        )
    )
    if reserved:
        raise _bad("Experiment namespace is already in use.", code=status.HTTP_409_CONFLICT)
    user.experiment_namespace = namespace
    try:
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        raise _bad("Experiment namespace is already in use.", code=status.HTTP_409_CONFLICT) from error
    refreshed = await db.scalar(
        select(User)
        .options(selectinload(User.user_roles).selectinload(UserRole.role))
        .where(User.id == user_id)
        .execution_options(populate_existing=True)
    )
    if refreshed is None:
        raise _bad("User inactive", code=status.HTTP_401_UNAUTHORIZED)
    return refreshed


async def _derived_counts(
    db: AsyncSession,
    experiment_ids: Iterable[int],
) -> dict[int, ExperimentDerivedCounts]:
    ids = normalize_int_ids(experiment_ids)
    counts = {experiment_id: ExperimentDerivedCounts() for experiment_id in ids}
    if not ids:
        return counts
    queries = (
        ("measurements", select(Measurement.experiment_id, func.count(Measurement.id)).where(Measurement.experiment_id.in_(ids)).group_by(Measurement.experiment_id)),
        ("recordedData", select(Measurement.experiment_id, func.count(RecordedData.id)).join(RecordedData, RecordedData.measurement_id == Measurement.id).where(Measurement.experiment_id.in_(ids)).group_by(Measurement.experiment_id)),
        ("designerModels", select(DesignerModel.experiment_id, func.count(DesignerModel.id)).where(DesignerModel.experiment_id.in_(ids)).group_by(DesignerModel.experiment_id)),
        ("predictorModels", select(PredictorModel.experiment_id, func.count(PredictorModel.id)).where(PredictorModel.experiment_id.in_(ids)).group_by(PredictorModel.experiment_id)),
    )
    for field, query in queries:
        for experiment_id, count in (await db.execute(query)).all():
            setattr(counts[experiment_id], field, count)
    return counts


def _source_locked(counts: ExperimentDerivedCounts) -> bool:
    return any(counts.model_dump().values())


async def experiment_usage(db: AsyncSession, experiment_ids: Iterable[int], *, user: Any) -> dict[str, Any]:
    ids = normalize_int_ids(experiment_ids)
    query = select(Experiment.id).where(Experiment.id.in_(ids))
    if not is_admin_user(user):
        query = query.where(Experiment.user_id == user.id)
    visible_ids = set((await db.scalars(query)).all())
    if visible_ids != set(ids):
        raise _bad("Experiment not found.", code=status.HTTP_404_NOT_FOUND)
    counts = await _derived_counts(db, ids)
    return {
        "items": [
            {
                "experimentId": experiment_id,
                "sourceLocked": _source_locked(counts[experiment_id]),
                "derivedCounts": counts[experiment_id].model_dump(),
            }
            for experiment_id in ids
        ]
    }


def _save_response(
    experiment: Experiment,
    action: str,
    counts: ExperimentDerivedCounts,
) -> SaveExperimentResponse:
    return SaveExperimentResponse(
        id=experiment.id,
        action=action,
        namespace=experiment.namespace,
        repository=experiment.repository_slug,
        key=experiment.experiment_key,
        version=_version_text(experiment),
        coordinate=_coordinate(experiment),
        bundleHash=experiment.source_hash,
        sourceLocked=_source_locked(counts),
        derivedCounts=counts,
    )


async def save_experiment(
    db: AsyncSession,
    request: SaveExperimentRequest,
    *,
    user: Any,
) -> SaveExperimentResponse:
    source_bundle = validate_source_bundle(request.sourceBundle)
    source_hash = _bundle_hash(source_bundle)
    if source_hash != request.bundleHash:
        raise _bad("bundleHash does not match sourceBundle.", code=status.HTTP_400_BAD_REQUEST)
    name = request.name.strip()
    if not name:
        raise _bad("Experiment name must not be blank.")

    counts = ExperimentDerivedCounts()
    if request.mode == "create":
        owner = await db.scalar(select(User).where(User.id == user.id).with_for_update())
        if owner is None or owner.experiment_namespace is None:
            raise _bad("Set an Experiment namespace before saving.", code=status.HTTP_409_CONFLICT)
        if SLUG_RE.fullmatch(request.repository or "") is None:
            raise _bad("Experiment repository format is invalid.")
        if SLUG_RE.fullmatch(request.key or "") is None:
            raise _bad("Experiment key format is invalid.")
        major, minor, patch = _parse_version(request.initialVersion)
        experiment = Experiment(
            user_id=user.id,
            namespace=owner.experiment_namespace,
            repository_slug=request.repository,
            experiment_key=request.key,
            version_major=major,
            version_minor=minor,
            version_patch=patch,
            name=name,
            description=request.description,
            source_bundle=source_bundle,
            source_hash=source_hash,
        )
        db.add(experiment)
    else:
        visible_experiment = await db.get(Experiment, request.experimentId)
        if visible_experiment is None or (
            not is_admin_user(user) and visible_experiment.user_id != user.id
        ):
            raise _bad("Experiment not found.", code=status.HTTP_404_NOT_FOUND)
        owner = await db.scalar(
            select(User).where(User.id == visible_experiment.user_id).with_for_update()
        )
        if owner is None:
            raise _bad("Experiment owner is unavailable.", code=status.HTTP_409_CONFLICT)
        experiment = await db.scalar(
            select(Experiment)
            .where(Experiment.id == request.experimentId)
            .with_for_update()
        )
        if experiment is None or experiment.user_id != owner.id:
            raise _bad("Experiment not found.", code=status.HTTP_404_NOT_FOUND)
        if experiment.source_hash != request.baseBundleHash:
            raise _bad(
                "The saved source bundle changed before this save.",
                code=status.HTTP_409_CONFLICT,
            )
        if request.mode == "overwrite":
            counts = (await _derived_counts(db, [experiment.id]))[experiment.id]
            if source_hash != experiment.source_hash and _source_locked(counts):
                raise _bad(
                    {
                        "code": "experiment_source_locked",
                        "message": "Experiment source cannot be overwritten while derived data exists.",
                        "derivedCounts": counts.model_dump(),
                    },
                    code=status.HTTP_409_CONFLICT,
                )
            experiment.name = name
            experiment.description = request.description
            experiment.source_bundle = source_bundle
            experiment.source_hash = source_hash
        else:
            latest = await db.scalar(
                select(Experiment)
                .where(
                    Experiment.user_id == experiment.user_id,
                    Experiment.namespace == experiment.namespace,
                    Experiment.repository_slug == experiment.repository_slug,
                    Experiment.experiment_key == experiment.experiment_key,
                )
                .order_by(
                    Experiment.version_major.desc(),
                    Experiment.version_minor.desc(),
                    Experiment.version_patch.desc(),
                )
                .limit(1)
                .with_for_update()
            )
            if latest is None:
                raise _bad("Experiment not found.", code=status.HTTP_404_NOT_FOUND)
            major, minor, patch = _bump_version(latest, request.bump or "patch")
            experiment = Experiment(
                user_id=experiment.user_id,
                namespace=experiment.namespace,
                repository_slug=experiment.repository_slug,
                experiment_key=experiment.experiment_key,
                version_major=major,
                version_minor=minor,
                version_patch=patch,
                name=name,
                description=request.description,
                source_bundle=source_bundle,
                source_hash=source_hash,
            )
            db.add(experiment)
    try:
        await db.flush()
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        raise _bad("Experiment coordinate and version already exists.", code=status.HTTP_409_CONFLICT) from error
    return _save_response(experiment, request.mode, counts)


async def delete_experiment_versions(
    db: AsyncSession,
    experiment_ids: Iterable[int],
    *,
    user: Any,
) -> None:
    ids = normalize_int_ids(experiment_ids)
    if not ids:
        return
    query = (
        select(Experiment)
        .where(Experiment.id.in_(ids))
        .order_by(Experiment.id)
        .with_for_update()
    )
    if not is_admin_user(user):
        query = query.where(Experiment.user_id == user.id)
    rows = list((await db.scalars(query)).all())
    if {row.id for row in rows} != set(ids):
        raise _bad("Experiment not found.", code=status.HTTP_404_NOT_FOUND)
    await _derived_counts(db, ids)
    await db.execute(delete(Experiment).where(Experiment.id.in_(ids)))
    await db.commit()


async def experiment_versions(
    db: AsyncSession,
    experiment_id: int,
    *,
    user: Any,
) -> dict[str, Any]:
    selected = await db.get(Experiment, experiment_id)
    if selected is None or (not is_admin_user(user) and selected.user_id != user.id):
        raise _bad("Experiment not found.", code=status.HTTP_404_NOT_FOUND)
    rows = list(
        (
            await db.scalars(
                select(Experiment)
                .where(
                    Experiment.user_id == selected.user_id,
                    Experiment.namespace == selected.namespace,
                    Experiment.repository_slug == selected.repository_slug,
                    Experiment.experiment_key == selected.experiment_key,
                )
                .order_by(
                    Experiment.version_major.desc(),
                    Experiment.version_minor.desc(),
                    Experiment.version_patch.desc(),
                )
            )
        ).all()
    )
    counts = await _derived_counts(db, [row.id for row in rows])
    items: list[dict[str, Any]] = []
    for row in rows:
        version = _version_text(row)
        derived = counts[row.id]
        items.append(
            {
                "id": row.id,
                "user_id": row.user_id,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
                "namespace": row.namespace,
                "repository_slug": row.repository_slug,
                "experiment_key": row.experiment_key,
                "version_major": row.version_major,
                "version_minor": row.version_minor,
                "version_patch": row.version_patch,
                "name": row.name,
                "description": row.description,
                "source_bundle": row.source_bundle,
                "source_hash": row.source_hash,
                "repository": row.repository_slug,
                "key": row.experiment_key,
                "version": version,
                "coordinate": _coordinate(row),
                "bundleHash": row.source_hash,
                "sourceLocked": _source_locked(derived),
                "derivedCounts": derived.model_dump(),
            }
        )
    return {"items": items}


async def enrich_experiment_list(db: AsyncSession, response: Any) -> Any:
    raw_items = response.items if hasattr(response, "items") else response["items"]
    items = [
        item.model_dump(mode="json") if hasattr(item, "model_dump") else dict(item)
        for item in raw_items
    ]
    ids = [item["id"] for item in items]
    counts = await _derived_counts(db, ids)
    for item in items:
        version = f"{item['version_major']}.{item['version_minor']}.{item['version_patch']}"
        derived = counts[item["id"]]
        item.update(
            {
                "repository": item["repository_slug"],
                "key": item["experiment_key"],
                "version": version,
                "coordinate": f"caemble:experiment/{item['namespace']}/{item['repository_slug']}/{item['experiment_key']}@{version}",
                "bundleHash": item["source_hash"],
                "sourceLocked": _source_locked(derived),
                "derivedCounts": derived.model_dump(),
            }
        )
    if hasattr(response, "items"):
        response.items = items
    else:
        response["items"] = items
    return response
