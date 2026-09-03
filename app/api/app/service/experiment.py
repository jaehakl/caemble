from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from db import Calculation, Experiment, ExperimentDemo, ExperimentNamespace, ExperimentRecord, Measurement, RecordedData
from models import (
    ExperimentBase,
    ExperimentRecordBase,
    ExperimentRecordContract,
    ExperimentRecordListRequest,
    ExperimentSourceBundle,
    GetListRequestBase,
    SaveExperimentRequest,
    UserData,
)
from user_auth.db import User
from service.experiment_access import require_experiment_read
from utils.crud import CrudSpec, get_list_response
from utils.crud.common import is_admin_user, normalize_int_ids


EXPERIMENT_CRUD_SPEC = CrudSpec(
    model=Experiment,
    schema=ExperimentBase,
    search_aliases={
        "workbench": (
            "name",
            "description",
            "namespace",
            "repository_slug",
            "experiment_key",
            "source_bundle",
        ),
        "repository": ("repository_slug",),
        "key": ("experiment_key",),
    },
)

EXPERIMENT_RECORD_CRUD_SPEC = CrudSpec(
    model=ExperimentRecord,
    schema=ExperimentRecordBase,
    scope_path=("experiment",),
)

_RECORD_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}(?:\.[A-Za-z_][A-Za-z0-9_]{0,62})*$")


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


def _record_payload(record: ExperimentRecordContract | ExperimentRecord) -> dict[str, Any]:
    return {
        "name": record.name,
        "quantity_kind": record.quantity_kind,
        "tensor_order": record.tensor_order,
        "dtype": record.dtype,
        "data_schema": record.data_schema,
    }


def _record_hash(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def _sync_experiment_records(
    db: AsyncSession,
    experiment: Experiment,
    records: list[ExperimentRecordContract],
    counts: dict[str, int],
) -> None:
    requested: dict[str, dict[str, Any]] = {}
    for record in records:
        payload = _record_payload(record)
        name = record.name.strip()
        if not _RECORD_NAME.fullmatch(name):
            raise _bad(f"Invalid ExperimentRecord name: {record.name}")
        if name in requested:
            raise _bad(f"Duplicate ExperimentRecord name: {name}")
        if record.tensor_order < 0:
            raise _bad(f"ExperimentRecord tensor_order must be non-negative: {name}")
        payload["name"] = name
        requested[name] = payload

    existing = list(
        (
            await db.scalars(
                select(ExperimentRecord)
                .where(ExperimentRecord.experiment_id == experiment.id)
                .order_by(ExperimentRecord.id)
                .with_for_update()
            )
        ).all()
    )
    existing_payloads = {record.name: _record_payload(record) for record in existing}
    if existing_payloads != requested and _source_locked(counts):
        raise _bad(
            {
                "code": "experiment_record_contract_locked",
                "message": "ExperimentRecord contract cannot change while derived data exists.",
                "expected": existing_payloads,
                "actual": requested,
            },
            code=status.HTTP_409_CONFLICT,
        )

    existing_by_name = {record.name: record for record in existing}
    for name, payload in requested.items():
        record = existing_by_name.get(name)
        if record is None:
            record = ExperimentRecord(experiment_id=experiment.id)
            db.add(record)
        record.name = name
        record.quantity_kind = payload["quantity_kind"]
        record.tensor_order = payload["tensor_order"]
        record.dtype = payload["dtype"]
        record.data_schema = payload["data_schema"]
        record.contract_hash = _record_hash(payload)
    missing_ids = [record.id for record in existing if record.name not in requested]
    if missing_ids:
        await db.execute(delete(ExperimentRecord).where(ExperimentRecord.id.in_(missing_ids)))


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
) -> dict[int, dict[str, int]]:
    ids = normalize_int_ids(experiment_ids)
    counts = {
        experiment_id: {"measurements": 0, "recordedData": 0, "calculations": 0}
        for experiment_id in ids
    }
    if not ids:
        return counts
    queries = (
        ("measurements", select(Measurement.experiment_id, func.count(Measurement.id)).where(Measurement.experiment_id.in_(ids)).group_by(Measurement.experiment_id)),
        ("recordedData", select(Measurement.experiment_id, func.count(RecordedData.id)).join(RecordedData, RecordedData.measurement_id == Measurement.id).where(Measurement.experiment_id.in_(ids)).group_by(Measurement.experiment_id)),
        ("calculations", select(Calculation.experiment_id, func.count(Calculation.id)).where(Calculation.experiment_id.in_(ids)).group_by(Calculation.experiment_id)),
    )
    for field, query in queries:
        for experiment_id, count in (await db.execute(query)).all():
            counts[experiment_id][field] = count
    return counts


def _source_locked(counts: dict[str, int]) -> bool:
    return any(counts.values())


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
                "derivedCounts": counts[experiment_id],
            }
            for experiment_id in ids
        ]
    }


def _save_response(
    experiment: Experiment,
    action: str,
    counts: dict[str, int],
) -> dict[str, Any]:
    return {
        "id": experiment.id,
        "action": action,
        "namespace": experiment.namespace,
        "repository": experiment.repository_slug,
        "key": experiment.experiment_key,
        "version": _version_text(experiment),
        "coordinate": _coordinate(experiment),
        "bundleHash": experiment.source_hash,
        "sourceLocked": _source_locked(counts),
        "derivedCounts": counts,
    }


async def save_experiment(
    db: AsyncSession,
    request: SaveExperimentRequest,
    *,
    user: Any,
) -> dict[str, Any]:
    source_bundle = _source_bundle_payload(request.sourceBundle)
    source_hash = _bundle_hash(source_bundle)
    name = request.name.strip()
    namespace = request.namespace.strip()
    repository = request.repository.strip()
    key = request.key.strip()
    if namespace == "caemble":
        raise _bad("The caemble namespace is reserved for Examples.", code=status.HTTP_409_CONFLICT)

    counts = {"measurements": 0, "recordedData": 0, "calculations": 0}
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
                        "derivedCounts": counts,
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
        await _sync_experiment_records(db, experiment, request.records, counts)
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
    remaining_demos = list(
        (
            await db.scalars(
                select(ExperimentDemo)
                .order_by(ExperimentDemo.display_order, ExperimentDemo.experiment_id)
                .with_for_update()
            )
        ).all()
    )
    if remaining_demos and not any(demo.is_default for demo in remaining_demos):
        remaining_demos[0].is_default = True
    for owner_id, namespaces in namespaces_by_owner.items():
        await _cleanup_empty_namespaces(db, owner_id, namespaces)
    await db.commit()


async def experiment_versions(
    db: AsyncSession,
    experiment_id: int,
    *,
    user: Any | None,
) -> dict[str, Any]:
    selected = await db.get(Experiment, experiment_id)
    if selected is None:
        raise _bad("Experiment not found.", code=status.HTTP_404_NOT_FOUND)
    await require_experiment_read(db, experiment_id, user=user)
    can_read_sibling_versions = is_admin_user(user) or (user is not None and selected.user_id == user.id)
    rows = list(
        (
            await db.scalars(
                select(Experiment)
                .where(
                    (
                        (
                            (Experiment.user_id == selected.user_id)
                            & (Experiment.namespace == selected.namespace)
                            & (Experiment.repository_slug == selected.repository_slug)
                            & (Experiment.experiment_key == selected.experiment_key)
                        )
                        if can_read_sibling_versions
                        else Experiment.id == selected.id
                    ),
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
                "derivedCounts": derived,
            }
        )
    return {"items": items}


async def enrich_experiment_list(db: AsyncSession, response: Any) -> Any:
    items = [
        item.model_dump(mode="json") if hasattr(item, "model_dump") else dict(item)
        for item in response["items"]
    ]
    ids = [item["id"] for item in items]
    counts = await _derived_counts(db, ids)
    demos = {
        demo.experiment_id: demo
        for demo in (
            await db.scalars(select(ExperimentDemo).where(ExperimentDemo.experiment_id.in_(ids)))
        ).all()
    }
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
                "derivedCounts": derived,
                "isDemo": item["id"] in demos,
                "demoOrder": demos[item["id"]].display_order if item["id"] in demos else None,
                "demoDefault": demos[item["id"]].is_default if item["id"] in demos else False,
            }
        )
    response["items"] = items
    return response


async def list_experiments(
    db: AsyncSession,
    request: GetListRequestBase,
    *,
    user: UserData | None,
) -> dict[str, Any]:
    response = await get_list_response(
        db,
        request,
        EXPERIMENT_CRUD_SPEC,
        user=user,
    )
    return await enrich_experiment_list(db, response)


async def list_experiment_records(
    db: AsyncSession,
    request: ExperimentRecordListRequest,
    *,
    user: UserData | None,
) -> dict[str, Any]:
    return await get_list_response(
        db,
        request,
        EXPERIMENT_RECORD_CRUD_SPEC,
        ExperimentRecord.experiment_id == request.experiment_id,
        user=user,
    )
