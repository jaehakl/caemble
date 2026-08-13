from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import and_, delete, func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from db import (
    Experiment,
    ExperimentGeometryModule,
    ExperimentGeometryImport,
    GeometryImport,
    GeometryPackage,
    GeometryRepository,
    GeometryVersion,
)
from models import (
    GeometryExperimentReferenceRow,
    GeometryPackageRow,
    GeometryRepositoryCreateRequest,
    GeometryRepositoryRow,
    GeometryVersionRow,
    GetListRequestBase,
)
from service.geometry.graph import _load_graph, _snapshot_modules, _version_rows
from service.geometry.source import (
    MAX_MODULES,
    _bad,
    _row_coordinate,
    _semver,
    _validate_namespace,
    _validate_slug,
    analyze_geometry_source,
)
from user_auth.db import User, UserRole
from utils.crud import CrudSpec, get_list_response, get_scope_owner_ids, normalize_int_ids
from utils.crud.common import is_admin_user


REPOSITORY_CRUD_SPEC = CrudSpec(model=GeometryRepository, schema=GeometryRepositoryRow)
PACKAGE_CRUD_SPEC = CrudSpec(
    model=GeometryPackage,
    schema=GeometryPackageRow,
    scope_path=("repository",),
)
VERSION_CRUD_SPEC = CrudSpec(
    model=GeometryVersion,
    schema=GeometryVersionRow,
    scope_path=("package", "repository"),
)
EXPERIMENT_REFERENCE_CRUD_SPEC = CrudSpec(
    model=Experiment,
    schema=GeometryExperimentReferenceRow,
)


async def change_geometry_namespace(
    db: AsyncSession,
    user_id: str,
    namespace: str,
) -> User:
    _validate_namespace(namespace)
    user = await db.scalar(
        select(User)
        .options(selectinload(User.user_roles).selectinload(UserRole.role))
        .where(User.id == user_id)
        .with_for_update()
    )
    if user is None:
        raise _bad("User inactive", code=status.HTTP_401_UNAUTHORIZED)
    if user.geometry_namespace == namespace:
        return user

    reserved = await db.scalar(
        select(func.count()).select_from(GeometryRepository).where(
            GeometryRepository.namespace == namespace,
            GeometryRepository.user_id.is_(None),
        )
    )
    if reserved:
        raise _bad(
            "Geometry namespace is already in use.",
            code=status.HTTP_409_CONFLICT,
        )

    user.geometry_namespace = namespace
    try:
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        raise _bad(
            "Geometry namespace is already in use.",
            code=status.HTTP_409_CONFLICT,
        ) from error

    user = await db.scalar(
        select(User)
        .options(selectinload(User.user_roles).selectinload(UserRole.role))
        .where(User.id == user_id)
        .execution_options(populate_existing=True)
    )
    if user is None:
        raise _bad("User inactive", code=status.HTTP_401_UNAUTHORIZED)
    return user


async def _lock_geometry_owner(db: AsyncSession, owner_id: str | None) -> User:
    if owner_id is None:
        raise _bad("Geometry owner is no longer available.", code=status.HTTP_409_CONFLICT)
    owner = await db.scalar(select(User).where(User.id == owner_id).with_for_update())
    if owner is None or owner.geometry_namespace is None:
        raise _bad("Set a Geometry namespace before publishing.", code=status.HTTP_409_CONFLICT)
    return owner


async def create_repository(
    db: AsyncSession,
    payload: GeometryRepositoryCreateRequest,
    *,
    user: Any,
) -> dict[str, Any]:
    _validate_slug(payload.slug, "repository slug")
    owner = await _lock_geometry_owner(db, user.id)
    repository = GeometryRepository(
        user_id=user.id,
        namespace=owner.geometry_namespace,
        slug=payload.slug,
        description=payload.description,
    )
    db.add(repository)
    try:
        await db.flush()
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        raise _bad("Geometry repository slug is already in use.", code=status.HTTP_409_CONFLICT) from error
    return _repository_response(repository)


async def archive_repository(
    db: AsyncSession,
    repository_id: int,
    *,
    user: Any,
) -> dict[str, Any]:
    repository = await db.get(GeometryRepository, repository_id)
    if repository is None or (not is_admin_user(user) and repository.user_id != user.id):
        raise _bad("Geometry repository not found.", code=status.HTTP_404_NOT_FOUND)
    if repository.user_id is not None:
        await _lock_geometry_owner(db, repository.user_id)
    row = (
        await db.execute(
            select(GeometryRepository)
            .where(GeometryRepository.id == repository_id)
            .with_for_update(of=GeometryRepository)
        )
    ).first()
    if row is None or (not is_admin_user(user) and row[0].user_id != user.id):
        raise _bad("Geometry repository not found.", code=status.HTTP_404_NOT_FOUND)
    repository = row[0]
    repository.archived_at = repository.archived_at or datetime.now(timezone.utc)
    await db.flush()
    await db.refresh(repository)
    response = _repository_response(repository)
    await db.commit()
    return response


async def update_repository_description(
    db: AsyncSession,
    repository_id: int,
    description: str | None,
    *,
    user: Any,
) -> dict[str, Any]:
    repository = await db.get(GeometryRepository, repository_id)
    if repository is None or (not is_admin_user(user) and repository.user_id != user.id):
        raise _bad("Geometry repository not found.", code=status.HTTP_404_NOT_FOUND)
    if repository.user_id is not None:
        await _lock_geometry_owner(db, repository.user_id)
    repository = await db.scalar(
        select(GeometryRepository)
        .where(GeometryRepository.id == repository_id)
        .with_for_update()
    )
    if repository is None or (not is_admin_user(user) and repository.user_id != user.id):
        raise _bad("Geometry repository not found.", code=status.HTTP_404_NOT_FOUND)
    repository.description = description.strip() if description and description.strip() else None
    await db.flush()
    response = _repository_response(repository)
    await db.commit()
    return response


def _repository_response(repository: GeometryRepository) -> dict[str, Any]:
    return {
        "id": repository.id,
        "userId": repository.user_id,
        "namespace": repository.namespace,
        "slug": repository.slug,
        "description": repository.description,
        "archivedAt": repository.archived_at,
        "createdAt": repository.created_at,
        "updatedAt": repository.updated_at,
    }


def _version_response(
    row: tuple[GeometryVersion, GeometryPackage, GeometryRepository, str],
) -> dict[str, Any]:
    version = row[0]
    return {
        "id": version.id,
        "packageId": version.package_id,
        "coordinate": _row_coordinate(row),
        "version": _semver(version),
        "description": version.description,
        "sourceHash": version.source_hash,
        "moduleHash": version.module_hash,
        "moduleFormatVersion": 3,
        "cadApiVersion": 5,
        "archivedAt": version.archived_at,
        "createdAt": version.created_at,
    }


def _owned_list_request(
    request: GetListRequestBase,
    user: Any,
) -> GetListRequestBase:
    return request if is_admin_user(user) else request.model_copy(update={"scope": "mine"})


def _package_list_request(
    request: GetListRequestBase,
) -> tuple[GetListRequestBase, Any | None]:
    clauses = []
    if request.search_text and request.search_text.strip():
        needle = f"%{request.search_text.strip()}%"
        clauses.append(
            or_(
                GeometryPackage.name.ilike(needle),
                GeometryPackage.repository.has(
                    or_(
                        GeometryRepository.namespace.ilike(needle),
                        GeometryRepository.slug.ilike(needle),
                    )
                ),
            )
        )
    text_filter = dict(request.text_filter or {})
    namespaces = [value for value in text_filter.pop("namespace", []) if value]
    owner_filters = [value for value in text_filter.pop("owner_id", []) if value]
    owner_ids = [value for value in owner_filters if value != "__orphan__"]
    if namespaces:
        clauses.append(
            GeometryPackage.repository.has(
                GeometryRepository.namespace.in_(namespaces)
            )
        )
    if owner_filters:
        owner_clauses = (
            [GeometryRepository.user_id.in_(owner_ids)] if owner_ids else []
        )
        if "__orphan__" in owner_filters:
            owner_clauses.append(GeometryRepository.user_id.is_(None))
        clauses.append(GeometryPackage.repository.has(or_(*owner_clauses)))
    null_filter = dict(request.null_filter or {})
    repository_archived = null_filter.pop("repository_archived_at", None)
    if repository_archived:
        archived_clause = (
            GeometryRepository.archived_at.is_(None)
            if repository_archived == "is_null"
            else GeometryRepository.archived_at.is_not(None)
        )
        clauses.append(GeometryPackage.repository.has(archived_clause))
    normalized = request.model_copy(
        update={
            "search_text": None,
            "text_filter": text_filter,
            "null_filter": null_filter,
        }
    )
    return normalized, and_(*clauses) if clauses else None


def _experiment_list_request(
    request: GetListRequestBase,
) -> tuple[GetListRequestBase, Any | None]:
    if not request.search_text or not request.search_text.strip():
        return request, None
    needle = f"%{request.search_text.strip()}%"
    return request.model_copy(update={"search_text": None}), or_(
        Experiment.name.ilike(needle),
        Experiment.description.ilike(needle),
    )


async def _enrich_package_list_response(db: AsyncSession, response: Any) -> dict[str, Any]:
    items = [item.model_dump(mode="json") for item in response.items]
    package_ids = [item["id"] for item in items if item.get("id")]
    if not package_ids:
        return {"total": response.total, "items": items}
    package_rows = (
        await db.execute(
            select(GeometryPackage, GeometryRepository)
            .join(GeometryRepository, GeometryPackage.repository_id == GeometryRepository.id)
            .where(GeometryPackage.id.in_(package_ids))
        )
    ).all()
    versions = (
        await db.execute(
            select(GeometryVersion)
            .where(GeometryVersion.package_id.in_(package_ids))
            .order_by(
                GeometryVersion.package_id,
                GeometryVersion.version_major.desc(),
                GeometryVersion.version_minor.desc(),
                GeometryVersion.version_patch.desc(),
            )
        )
    ).scalars().all()
    versions_by_package: dict[int, list[GeometryVersion]] = {}
    for version in versions:
        versions_by_package.setdefault(version.package_id, []).append(version)
    metadata = {}
    for package, repository in package_rows:
        active_versions = [item for item in versions_by_package.get(package.id, []) if item.archived_at is None]
        latest = active_versions[0] if active_versions else None
        metadata[package.id] = {
            "user_id": repository.user_id,
            "namespace": repository.namespace,
            "repository": repository.slug,
            "repository_archived_at": repository.archived_at,
            "version_count": len(versions_by_package.get(package.id, [])),
            "latest_version": _semver(latest) if latest else None,
        }
    return {
        "total": response.total,
        "items": [{**item, **metadata.get(item["id"], {})} for item in items],
    }


async def _enrich_version_list_response(db: AsyncSession, response: Any) -> dict[str, Any]:
    items = [item.model_dump(mode="json") for item in response.items]
    ids = {item["id"] for item in items if item.get("id")}
    rows = await _version_rows(db, ids)
    metadata = {
        version_id: {
            "repository_id": row[2].id,
            "namespace": row[2].namespace,
            "repository": row[2].slug,
            "package_name": row[1].name,
            "coordinate": _row_coordinate(row),
            "version": _semver(row[0]),
        }
        for version_id, row in rows.items()
    }
    return {
        "total": response.total,
        "items": [{**item, **metadata.get(item["id"], {})} for item in items],
    }


async def _enrich_experiment_reference_list_response(
    db: AsyncSession,
    response: Any,
    *,
    geometry_version_id: int,
) -> dict[str, Any]:
    items = [item.model_dump(mode="json") for item in response.items]
    experiment_ids = [item["id"] for item in items if item.get("id")]
    aliases: dict[int, str] = {}
    for experiment_id, alias in (
        await db.execute(
            select(ExperimentGeometryImport.experiment_id, ExperimentGeometryImport.alias)
            .where(
                ExperimentGeometryImport.experiment_id.in_(experiment_ids),
                ExperimentGeometryImport.geometry_version_id == geometry_version_id,
            )
            .order_by(ExperimentGeometryImport.alias)
        )
    ).all():
        aliases.setdefault(experiment_id, alias)
    return {
        "total": response.total,
        "items": [{**item, "entry_alias": aliases.get(item["id"])} for item in items],
    }


async def list_geometry_repositories(
    db: AsyncSession,
    request: GetListRequestBase,
    *,
    user: Any,
) -> Any:
    return await get_list_response(
        db,
        _owned_list_request(request, user),
        REPOSITORY_CRUD_SPEC,
        user=user,
    )


async def list_geometry_packages(
    db: AsyncSession,
    request: GetListRequestBase,
    *,
    user: Any,
) -> dict[str, Any]:
    normalized, base_clause = _package_list_request(
        _owned_list_request(request, user)
    )
    response = await get_list_response(
        db,
        normalized,
        PACKAGE_CRUD_SPEC,
        base_clause,
        user=user,
    )
    return await _enrich_package_list_response(db, response)


async def list_geometry_versions(
    db: AsyncSession,
    request: GetListRequestBase,
    *,
    user: Any,
) -> dict[str, Any]:
    response = await get_list_response(
        db,
        _owned_list_request(request, user),
        VERSION_CRUD_SPEC,
        user=user,
    )
    return await _enrich_version_list_response(db, response)


async def list_geometry_version_dependents(
    db: AsyncSession,
    version_id: int,
    request: GetListRequestBase,
    *,
    user: Any,
) -> dict[str, Any]:
    await geometry_version_usage(db, [version_id], user=user)
    response = await get_list_response(
        db,
        _owned_list_request(request, user),
        VERSION_CRUD_SPEC,
        GeometryVersion.id.in_(
            select(GeometryImport.importer_geometry_version_id).where(
                GeometryImport.imported_geometry_version_id == version_id
            )
        ),
        user=user,
    )
    return await _enrich_version_list_response(db, response)


async def list_geometry_version_experiments(
    db: AsyncSession,
    version_id: int,
    request: GetListRequestBase,
    *,
    user: Any,
) -> dict[str, Any]:
    await geometry_version_usage(db, [version_id], user=user)
    normalized, search_clause = _experiment_list_request(
        _owned_list_request(request, user)
    )
    reference_clause = Experiment.id.in_(
        select(ExperimentGeometryModule.experiment_id).where(
            ExperimentGeometryModule.geometry_version_id == version_id
        )
    )
    response = await get_list_response(
        db,
        normalized,
        EXPERIMENT_REFERENCE_CRUD_SPEC,
        and_(reference_clause, search_clause)
        if search_clause is not None
        else reference_clause,
        user=user,
    )
    return await _enrich_experiment_reference_list_response(
        db,
        response,
        geometry_version_id=version_id,
    )


async def geometry_version_usage(
    db: AsyncSession,
    version_ids: list[object],
    *,
    user: Any,
) -> dict[str, Any]:
    normalized_ids = normalize_int_ids(version_ids, sort=True)
    if len(normalized_ids) > MAX_MODULES:
        raise _bad(f"At most {MAX_MODULES} Geometry versions may be inspected.")
    owner_ids = await get_scope_owner_ids(db, VERSION_CRUD_SPEC, normalized_ids)
    if len(owner_ids) != len(normalized_ids) or any(
        not is_admin_user(user) and owner_id != user.id
        for owner_id in owner_ids.values()
    ):
        raise _bad("Geometry version not found.", code=status.HTTP_404_NOT_FOUND)
    rows = await _version_rows(db, set(normalized_ids))
    if len(rows) != len(normalized_ids):
        raise _bad("Geometry version not found.", code=status.HTTP_404_NOT_FOUND)
    dependents: dict[int, set[int]] = {version_id: set() for version_id in normalized_ids}
    for imported_id, importer_id in (
        await db.execute(
            select(
                GeometryImport.imported_geometry_version_id,
                GeometryImport.importer_geometry_version_id,
            ).where(GeometryImport.imported_geometry_version_id.in_(normalized_ids))
        )
    ).all():
        dependents[imported_id].add(importer_id)
    experiment_counts = {
        version_id: count
        for version_id, count in (
            await db.execute(
                select(
                    ExperimentGeometryModule.geometry_version_id,
                    func.count(ExperimentGeometryModule.experiment_id),
                )
                .where(ExperimentGeometryModule.geometry_version_id.in_(normalized_ids))
                .group_by(ExperimentGeometryModule.geometry_version_id)
            )
        ).all()
    }
    return {
        "items": [
            {
                "versionId": version_id,
                "dependentVersionIds": sorted(dependents[version_id]),
                "dependentVersionCount": len(dependents[version_id]),
                "experimentCount": experiment_counts.get(version_id, 0),
                "deletable": not dependents[version_id] and not experiment_counts.get(version_id, 0),
            }
            for version_id in normalized_ids
        ]
    }


async def _lock_geometry_owners(db: AsyncSession, owner_ids: set[str | None]) -> None:
    for owner_id in sorted(item for item in owner_ids if item is not None):
        await _lock_geometry_owner(db, owner_id)


async def _enable_geometry_delete(db: AsyncSession) -> None:
    await db.execute(text("SELECT set_config('caemble.geometry_delete', 'on', true)"))


def _in_use_detail(usage: dict[str, Any]) -> dict[str, Any]:
    return {"code": "geometry_in_use", "usage": usage["items"]}


async def delete_geometry_versions(
    db: AsyncSession,
    version_ids: list[int],
    *,
    user: Any,
) -> None:
    normalized_ids = normalize_int_ids(version_ids, sort=True)
    if not normalized_ids:
        return
    owner_ids = await get_scope_owner_ids(db, VERSION_CRUD_SPEC, normalized_ids)
    if len(owner_ids) != len(normalized_ids) or any(
        not is_admin_user(user) and owner_id != user.id
        for owner_id in owner_ids.values()
    ):
        raise _bad("Geometry version not found.", code=status.HTTP_404_NOT_FOUND)
    rows = await _version_rows(db, set(normalized_ids))
    if len(rows) != len(normalized_ids):
        raise _bad("Geometry version not found.", code=status.HTTP_404_NOT_FOUND)
    await _lock_geometry_owners(db, {row[2].user_id for row in rows.values()})
    rows = await _version_rows(db, set(normalized_ids), lock=True)
    usage = await geometry_version_usage(db, normalized_ids, user=user)
    deleting = set(normalized_ids)
    blocked = [
        item
        for item in usage["items"]
        if item["experimentCount"] or any(version_id not in deleting for version_id in item["dependentVersionIds"])
    ]
    if blocked:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_in_use_detail({"items": blocked}),
        )
    try:
        await _enable_geometry_delete(db)
        await db.execute(
            delete(GeometryImport).where(
                GeometryImport.importer_geometry_version_id.in_(normalized_ids)
            )
        )
        await db.execute(delete(GeometryVersion).where(GeometryVersion.id.in_(normalized_ids)))
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        latest_usage = await geometry_version_usage(db, normalized_ids, user=user)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_in_use_detail(latest_usage),
        ) from error


async def delete_geometry_packages(
    db: AsyncSession,
    package_ids: list[int],
    *,
    user: Any,
) -> None:
    normalized_ids = normalize_int_ids(package_ids, sort=True)
    if not normalized_ids:
        return
    owner_ids = await get_scope_owner_ids(db, PACKAGE_CRUD_SPEC, normalized_ids)
    if len(owner_ids) != len(normalized_ids) or any(
        not is_admin_user(user) and owner_id != user.id
        for owner_id in owner_ids.values()
    ):
        raise _bad("Geometry package not found.", code=status.HTTP_404_NOT_FOUND)
    await _lock_geometry_owners(db, set(owner_ids.values()))
    locked_packages = (
        await db.execute(
            select(GeometryPackage).where(GeometryPackage.id.in_(normalized_ids)).with_for_update()
        )
    ).scalars().all()
    if len(locked_packages) != len(normalized_ids):
        raise _bad("Geometry package not found.", code=status.HTTP_404_NOT_FOUND)
    version_ids = list(
        (
            await db.execute(
                select(GeometryVersion.id).where(GeometryVersion.package_id.in_(normalized_ids))
            )
        ).scalars()
    )
    if version_ids:
        usage = await geometry_version_usage(db, version_ids, user=user)
        deleting = set(version_ids)
        blocked = [
            item
            for item in usage["items"]
            if item["experimentCount"]
            or any(version_id not in deleting for version_id in item["dependentVersionIds"])
        ]
        if blocked:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=_in_use_detail({"items": blocked}),
            )
    try:
        await _enable_geometry_delete(db)
        if version_ids:
            await db.execute(
                delete(GeometryImport).where(
                    GeometryImport.importer_geometry_version_id.in_(version_ids)
                )
            )
            await db.execute(delete(GeometryVersion).where(GeometryVersion.id.in_(version_ids)))
        await db.execute(delete(GeometryPackage).where(GeometryPackage.id.in_(normalized_ids)))
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        latest_usage = await geometry_version_usage(db, version_ids, user=user)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_in_use_detail(latest_usage),
        ) from error


async def resolve_version(db: AsyncSession, version_id: int, *, user: Any) -> dict[str, Any]:
    rows = await _version_rows(db, {version_id})
    row = rows.get(version_id)
    if row is None or (not is_admin_user(user) and row[2].user_id != user.id):
        raise _bad("Geometry version not found.", code=status.HTTP_404_NOT_FOUND)
    graph_rows, edges, bindings = await _load_graph(db, {version_id}, owner_id=row[2].user_id)
    return {
        "schemaVersion": 2,
        "root": {
            "geometryVersionId": version_id,
            "coordinate": _row_coordinate(row),
            "moduleHash": row[0].module_hash,
            "exports": analyze_geometry_source(row[0].source)["exports"],
        },
        "modules": [
            module.model_dump(mode="json")
            for module in _snapshot_modules(graph_rows, edges, bindings)
        ],
    }


async def archive_version(
    db: AsyncSession,
    version_id: int,
    *,
    user: Any,
) -> dict[str, Any]:
    unlocked = (await _version_rows(db, {version_id})).get(version_id)
    if unlocked is None or (not is_admin_user(user) and unlocked[2].user_id != user.id):
        raise _bad("Geometry version not found.", code=status.HTTP_404_NOT_FOUND)
    if unlocked[2].user_id is not None:
        await _lock_geometry_owner(db, unlocked[2].user_id)
    rows = await _version_rows(db, {version_id}, lock=True)
    row = rows.get(version_id)
    if row is None or (not is_admin_user(user) and row[2].user_id != user.id):
        raise _bad("Geometry version not found.", code=status.HTTP_404_NOT_FOUND)
    row[0].archived_at = row[0].archived_at or datetime.now(timezone.utc)
    await db.commit()
    return _version_response(row)
