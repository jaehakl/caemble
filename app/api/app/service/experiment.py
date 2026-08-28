from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from db import Calculation, Experiment, ExperimentNamespace, Measurement, RecordedData
from models import (
    ExperimentDerivedCounts,
    ExperimentSourceBundle,
    SaveExperimentRequest,
    SaveExperimentResponse,
)
from user_auth.db import User
from utils.crud.common import is_admin_user, normalize_int_ids


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
    parts = tuple(int(item) for item in (value or "").split("."))
    if len(parts) != 3:
        raise ValueError("initialVersion must contain three numeric components")
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
    return major, minor, patch


def _source_bundle_payload(bundle: ExperimentSourceBundle) -> dict[str, Any]:
    return bundle.model_dump(mode="json")


async def _claim_namespace(db: AsyncSession, user_id: str, namespace: str) -> None:
    inserted_owner = await db.scalar(
        pg_insert(ExperimentNamespace)
        .values(namespace=namespace, user_id=user_id)
        .on_conflict_do_nothing(index_elements=[ExperimentNamespace.namespace])
        .returning(ExperimentNamespace.user_id)
    )
    if inserted_owner is not None:
        return
    owner_id = await db.scalar(
        select(ExperimentNamespace.user_id)
        .where(ExperimentNamespace.namespace == namespace)
        .with_for_update()
    )
    if owner_id != user_id:
        raise _bad("Experiment namespace is already in use.", code=status.HTTP_409_CONFLICT)


async def _cleanup_empty_namespaces(db: AsyncSession, user_id: str, namespaces: Iterable[str]) -> None:
    values = sorted(set(namespaces))
    if not values:
        return
    await db.flush()
    await db.execute(
        delete(ExperimentNamespace).where(
            ExperimentNamespace.user_id == user_id,
            ExperimentNamespace.namespace.in_(values),
            ~select(Experiment.id)
            .where(
                Experiment.user_id == ExperimentNamespace.user_id,
                Experiment.namespace == ExperimentNamespace.namespace,
            )
            .exists(),
        )
    )


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
        ("calculations", select(Calculation.experiment_id, func.count(Calculation.id)).where(Calculation.experiment_id.in_(ids)).group_by(Calculation.experiment_id)),
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
    source_bundle = _source_bundle_payload(request.sourceBundle)
    source_hash = _bundle_hash(source_bundle)
    name = request.name.strip()
    namespace = request.namespace.strip()
    repository = request.repository.strip()
    key = request.key.strip()
    if namespace == "caemble":
        raise _bad("The caemble namespace is reserved for Examples.", code=status.HTTP_409_CONFLICT)

    counts = ExperimentDerivedCounts()
    if request.mode == "create":
        major, minor, patch = _parse_version(request.initialVersion)
        owner = await db.scalar(select(User).where(User.id == user.id).with_for_update())
        if owner is None:
            raise _bad("User inactive", code=status.HTTP_401_UNAUTHORIZED)
        await _claim_namespace(db, owner.id, namespace)
        target_exists = await db.scalar(
            select(Experiment.id)
            .where(
                Experiment.user_id == owner.id,
                Experiment.namespace == namespace,
                Experiment.repository_slug == repository,
                Experiment.experiment_key == key,
            )
            .limit(1)
            .with_for_update()
        )
        if target_exists is not None:
            raise _bad("Experiment identity is already in use.", code=status.HTTP_409_CONFLICT)
        experiment = Experiment(
            user_id=user.id,
            namespace=namespace,
            repository_slug=repository,
            experiment_key=key,
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
        previous_namespace = experiment.namespace
        previous_repository = experiment.repository_slug
        previous_key = experiment.experiment_key
        family = list(
            (
                await db.scalars(
                    select(Experiment)
                    .where(
                        Experiment.user_id == owner.id,
                        Experiment.namespace == previous_namespace,
                        Experiment.repository_slug == previous_repository,
                        Experiment.experiment_key == previous_key,
                    )
                    .order_by(Experiment.id)
                    .with_for_update()
                )
            ).all()
        )
        if not family:
            raise _bad("Experiment not found.", code=status.HTTP_404_NOT_FOUND)
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
        else:
            latest = max(
                family,
                key=lambda item: (item.version_major, item.version_minor, item.version_patch),
            )
            major, minor, patch = _bump_version(latest, request.bump or "patch")

        identity_changed = (previous_namespace, previous_repository, previous_key) != (namespace, repository, key)
        if identity_changed:
            target_exists = await db.scalar(
                select(func.count())
                .select_from(Experiment)
                .where(
                    Experiment.user_id == owner.id,
                    Experiment.namespace == namespace,
                    Experiment.repository_slug == repository,
                    Experiment.experiment_key == key,
                    Experiment.id.not_in([item.id for item in family]),
                )
            )
            if target_exists:
                raise _bad("Experiment identity is already in use.", code=status.HTTP_409_CONFLICT)
        await _claim_namespace(db, owner.id, namespace)
        for version in family:
            version.namespace = namespace
            version.repository_slug = repository
            version.experiment_key = key

        if request.mode == "overwrite":
            experiment.name = name
            experiment.description = request.description
            experiment.source_bundle = source_bundle
            experiment.source_hash = source_hash
        else:
            experiment = Experiment(
                user_id=experiment.user_id,
                namespace=namespace,
                repository_slug=repository,
                experiment_key=key,
                version_major=major,
                version_minor=minor,
                version_patch=patch,
                name=name,
                description=request.description,
                source_bundle=source_bundle,
                source_hash=source_hash,
            )
            db.add(experiment)
        if identity_changed:
            await _cleanup_empty_namespaces(db, owner.id, [previous_namespace])
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
    namespaces_by_owner: dict[str, set[str]] = {}
    for row in rows:
        namespaces_by_owner.setdefault(row.user_id, set()).add(row.namespace)
    await db.execute(delete(Experiment).where(Experiment.id.in_(ids)))
    for owner_id, namespaces in namespaces_by_owner.items():
        await _cleanup_empty_namespaces(db, owner_id, namespaces)
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
