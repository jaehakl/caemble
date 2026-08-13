from __future__ import annotations

import hashlib
import json
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from db import GeometryImport, GeometryPackage, GeometryRepository, GeometryVersion
from models import GeometryPublishPlanRequest, GeometryPublishRequest
from service.geometry.graph import (
    _assert_acyclic,
    _assert_max_depth,
    _load_graph,
    _resolve_coordinate,
    _snapshot_modules,
    _version_rows,
)
from service.geometry.manager import _lock_geometry_owner, _version_response
from service.geometry.source import (
    GEOMETRY_SEMVER_COMPONENT_MAX,
    LOCAL_COORDINATE_RE,
    MAX_GRAPH_SOURCE_BYTES,
    MAX_MODULES,
    MAX_MODULE_SOURCE_BYTES,
    SEMVER_RE,
    _bad,
    _bump,
    _coordinate,
    _local_coordinate,
    _row_coordinate,
    _semver,
    _semver_component_is_bounded,
    _validate_sha256,
    _validate_slug,
    _version_tuple,
    analyze_geometry_source,
    module_hash,
    rewrite_geometry_imports,
    source_hash,
)
from user_auth.db import User
from utils.crud.common import is_admin_user


class GeometryVersionConflict(Exception):
    def __init__(
        self,
        *,
        draft_id: str,
        coordinate: str,
        suggested_version: str,
        revised_plan: dict[str, Any] | None = None,
    ):
        self.payload = {
            "code": "geometry_version_conflict",
            "draftId": draft_id,
            "coordinate": coordinate,
            "suggestedVersion": suggested_version,
            "revisedPlan": revised_plan,
        }
        super().__init__(coordinate)


def _validate_publish_request(request: GeometryPublishPlanRequest) -> None:
    plan_hash = getattr(request, "planHash", None)
    if plan_hash is not None:
        _validate_sha256(plan_hash, "planHash")
    draft_ids = [draft.draftId for draft in request.drafts]
    if len(draft_ids) != len(set(draft_ids)):
        raise _bad("draftId values must be unique.", code=422)
    if request.targetDraftId not in set(draft_ids):
        raise _bad("targetDraftId must identify a draft.", code=422)
    base_ids = [draft.baseGeometryVersionId for draft in request.drafts if draft.baseGeometryVersionId]
    if len(base_ids) != len(set(base_ids)):
        raise _bad("Only one draft may target each published Geometry version.", code=422)
    total_bytes = 0
    for draft in request.drafts:
        _validate_slug(draft.repository, "repository slug")
        _validate_slug(draft.package, "package name")
        if draft.baseGeometryVersionId is None and draft.version is None:
            raise _bad("A new Geometry draft requires version.", code=422)
        if draft.baseGeometryVersionId is not None and draft.version is not None:
            raise _bad("An existing Geometry draft uses bump instead of version.", code=422)
        if draft.version is not None:
            if SEMVER_RE.fullmatch(draft.version) is None:
                raise _bad("Geometry version format is invalid.", code=422)
            if any(not _semver_component_is_bounded(part) for part in draft.version.split(".")):
                raise _bad(
                    f"Geometry version components must not exceed {GEOMETRY_SEMVER_COMPONENT_MAX}.",
                    code=422,
                )
        try:
            size = len(draft.source.encode("utf-8"))
        except UnicodeEncodeError as error:
            raise _bad("Geometry module source must contain valid UTF-8 text.", code=422) from error
        if size > MAX_MODULE_SOURCE_BYTES:
            raise _bad("Geometry module source exceeds 1 MiB.", code=422)
        total_bytes += size
        try:
            analyze_geometry_source(draft.source, allow_local=True)
        except HTTPException as error:
            if error.status_code == status.HTTP_400_BAD_REQUEST:
                raise _bad(error.detail, code=status.HTTP_422_UNPROCESSABLE_ENTITY) from error
            raise
    if total_bytes > MAX_GRAPH_SOURCE_BYTES:
        raise _bad("Publish request source exceeds 8 MiB.")


async def _draft_states(
    db: AsyncSession,
    request: GeometryPublishPlanRequest,
    *,
    user: Any,
) -> tuple[str, dict[str, dict[str, Any]]]:
    base_ids = {draft.baseGeometryVersionId for draft in request.drafts if draft.baseGeometryVersionId}
    base_rows = await _version_rows(db, set(base_ids))
    if len(base_rows) != len(base_ids):
        raise _bad("A Geometry draft base version was not found.", code=404)
    target = next(draft for draft in request.drafts if draft.draftId == request.targetDraftId)
    target_base = base_rows.get(target.baseGeometryVersionId) if target.baseGeometryVersionId else None
    owner_id = target_base[2].user_id if target_base else user.id
    if owner_id is None or (owner_id != user.id and not is_admin_user(user)):
        raise _bad("Geometry draft base version was not found.", code=404)
    owner = await db.get(User, owner_id)
    if owner is None or owner.geometry_namespace is None:
        raise _bad("Set a Geometry namespace before publishing.", code=409)
    repositories = list(
        (
            await db.execute(select(GeometryRepository).where(GeometryRepository.user_id == owner_id))
        ).scalars()
    )
    by_id = {item.id: item for item in repositories}
    by_current_slug = {
        item.slug: item
        for item in repositories
        if item.namespace == owner.geometry_namespace
    }
    states: dict[str, dict[str, Any]] = {}
    for draft in request.drafts:
        base = base_rows.get(draft.baseGeometryVersionId) if draft.baseGeometryVersionId else None
        repository = None
        if base is not None:
            if base[2].user_id != owner_id:
                raise _bad("All Geometry drafts in a publish request must have the same owner.")
            if base[0].archived_at is not None or base[2].archived_at is not None:
                raise _bad(f"Geometry draft base is archived: {draft.draftId}")
            if base[2].slug != draft.repository or base[1].name != draft.package:
                raise _bad(f"Draft {draft.draftId} repository/package does not match its base version.")
            if draft.repositoryId is not None and draft.repositoryId != base[2].id:
                raise _bad(f"Draft {draft.draftId} repositoryId does not match its base version.")
            repository = base[2]
        else:
            repository = by_id.get(draft.repositoryId) if draft.repositoryId else by_current_slug.get(draft.repository)
            if draft.repositoryId is not None and repository is None:
                raise _bad("Geometry repository not found.", code=404)
            if repository is not None and repository.slug != draft.repository:
                raise _bad(f"Draft {draft.draftId} repository does not match repositoryId.")
            if repository is not None and repository.archived_at is not None:
                raise _bad(f"Geometry repository is archived: {draft.repository}")
        namespace = repository.namespace if repository is not None else owner.geometry_namespace
        states[draft.draftId] = {
            "draft": draft,
            "base": base,
            "repository_id": repository.id if repository is not None else None,
            "namespace": namespace,
            "repository": draft.repository,
            "package": draft.package,
            "localCoordinate": _local_coordinate(namespace, draft.repository, draft.package),
            "description": draft.description,
            "source": draft.source,
            "analysis": analyze_geometry_source(draft.source, allow_local=True),
        }
    local_coordinates = [state["localCoordinate"] for state in states.values()]
    if len(local_coordinates) != len(set(local_coordinates)):
        raise _bad("Only one @local draft may exist for a Geometry package.", code=422)
    return owner_id, states


def _selected_closure(states: dict[str, dict[str, Any]], target_id: str) -> set[str]:
    by_local = {state["localCoordinate"]: draft_id for draft_id, state in states.items()}
    selected = {target_id}
    pending = [target_id]
    while pending:
        draft_id = pending.pop()
        for imported in states[draft_id]["analysis"]["imports"]:
            coordinate = imported["coordinate"]
            if LOCAL_COORDINATE_RE.fullmatch(coordinate) is None:
                continue
            child_id = by_local.get(coordinate)
            if child_id is None:
                raise _bad(f"Unresolved local Geometry import: {coordinate}", code=422)
            if child_id == draft_id:
                raise _bad("A Geometry draft cannot import itself.", code=422)
            if child_id not in selected:
                selected.add(child_id)
                pending.append(child_id)
    return selected


async def _allocate_versions(
    db: AsyncSession,
    states: dict[str, dict[str, Any]],
    selected: set[str],
) -> None:
    for draft_id in sorted(selected):
        state = states[draft_id]
        draft = state["draft"]
        base = state["base"]
        if base is None:
            version = _version_tuple(draft.version or "")
        else:
            latest = await db.scalar(
                select(GeometryVersion)
                .where(GeometryVersion.package_id == base[1].id)
                .order_by(
                    GeometryVersion.version_major.desc(),
                    GeometryVersion.version_minor.desc(),
                    GeometryVersion.version_patch.desc(),
                )
                .limit(1)
            )
            version = _bump(
                (latest.version_major, latest.version_minor, latest.version_patch),
                draft.bump,
            )
        version_text = ".".join(str(part) for part in version)
        state["version"] = version_text
        state["coordinate"] = _coordinate(
            state["namespace"], state["repository"], state["package"], version_text
        )
    coordinates = [states[draft_id]["coordinate"] for draft_id in selected]
    if len(coordinates) != len(set(coordinates)):
        raise _bad("Geometry drafts must have unique proposed coordinates.")


async def _assert_version_available(
    db: AsyncSession,
    state: dict[str, Any],
    *,
    draft_id: str,
    owner_id: str,
) -> None:
    existing = await _resolve_coordinate(db, state["coordinate"], owner_id=owner_id)
    if existing is None:
        return
    latest = await db.scalar(
        select(GeometryVersion)
        .where(GeometryVersion.package_id == existing[1].id)
        .order_by(
            GeometryVersion.version_major.desc(),
            GeometryVersion.version_minor.desc(),
            GeometryVersion.version_patch.desc(),
        )
        .limit(1)
    )
    bump = state["draft"].bump if state["base"] is not None else "patch"
    suggested = _bump((latest.version_major, latest.version_minor, latest.version_patch), bump)
    raise GeometryVersionConflict(
        draft_id=draft_id,
        coordinate=state["coordinate"],
        suggested_version=".".join(str(part) for part in suggested),
    )


async def plan_publish(
    db: AsyncSession,
    request: GeometryPublishPlanRequest,
    *,
    user: Any,
) -> dict[str, Any]:
    _validate_publish_request(request)
    owner_id, states = await _draft_states(db, request, user=user)
    selected = _selected_closure(states, request.targetDraftId)
    if len(selected) > MAX_MODULES:
        raise _bad(f"A publish plan may contain at most {MAX_MODULES} modules.")
    await _allocate_versions(db, states, selected)
    for draft_id in selected:
        await _assert_version_available(db, states[draft_id], draft_id=draft_id, owner_id=owner_id)

    local_replacements = {
        states[draft_id]["localCoordinate"]: states[draft_id]["coordinate"]
        for draft_id in selected
    }
    planned_by_coordinate = {states[draft_id]["coordinate"]: draft_id for draft_id in selected}
    for draft_id in selected:
        state = states[draft_id]
        state["finalSource"] = rewrite_geometry_imports(state["source"], local_replacements)
        state["finalAnalysis"] = analyze_geometry_source(state["finalSource"])

    external_rows: dict[int, tuple[GeometryVersion, GeometryPackage, GeometryRepository, str]] = {}
    dependencies: dict[str, list[dict[str, Any]]] = {draft_id: [] for draft_id in selected}
    for draft_id in selected:
        for imported in states[draft_id]["finalAnalysis"]["imports"]:
            coordinate = imported["coordinate"]
            child_draft_id = planned_by_coordinate.get(coordinate)
            if child_draft_id is not None:
                if imported["exportName"] not in states[child_draft_id]["finalAnalysis"]["exports"]:
                    raise _bad(f"Imported Geometry export does not exist: {imported['exportName']}", code=422)
                dependencies[draft_id].append(
                    {
                        "exportName": imported["exportName"],
                        "alias": imported["alias"],
                        "draftId": child_draft_id,
                        "coordinate": coordinate,
                    }
                )
                continue
            row = await _resolve_coordinate(db, coordinate, owner_id=owner_id)
            if row is None:
                raise _bad(f"Geometry import was not found: {coordinate}", code=404)
            external_rows[row[0].id] = row
            child_analysis = analyze_geometry_source(row[0].source)
            if imported["exportName"] not in child_analysis["exports"]:
                raise _bad(f"Imported Geometry export does not exist: {imported['exportName']}", code=422)
            dependencies[draft_id].append(
                {
                    "exportName": imported["exportName"],
                    "alias": imported["alias"],
                    "geometryVersionId": row[0].id,
                    "coordinate": coordinate,
                    "moduleHash": row[0].module_hash,
                }
            )

    external_edges: dict[int, list[int]] = {}
    external_bindings: dict[int, list[tuple[str, str, int]]] = {}
    if external_rows:
        external_rows, external_edges, external_bindings = await _load_graph(
            db,
            set(external_rows),
            owner_id=owner_id,
        )
        _snapshot_modules(external_rows, external_edges, external_bindings)
    if len(selected) + len(external_rows) > MAX_MODULES:
        raise _bad(f"Geometry graph may contain at most {MAX_MODULES} modules.")
    total_bytes = sum(len(states[item]["finalSource"].encode("utf-8")) for item in selected)
    total_bytes += sum(len(row[0].source.encode("utf-8")) for row in external_rows.values())
    if total_bytes > MAX_GRAPH_SOURCE_BYTES:
        raise _bad("Geometry graph source exceeds 8 MiB.")

    edges: dict[Any, list[Any]] = dict(external_edges)
    for draft_id, items in dependencies.items():
        edges[draft_id] = [item.get("draftId") or item["geometryVersionId"] for item in items]
    _assert_acyclic(edges, error_code=status.HTTP_422_UNPROCESSABLE_ENTITY)
    _assert_max_depth(edges, set(selected), error_code=status.HTTP_422_UNPROCESSABLE_ENTITY)

    order: list[str] = []
    visited: set[str] = set()

    def visit(draft_id: str) -> None:
        if draft_id in visited:
            return
        for child in dependencies[draft_id]:
            if child.get("draftId") is not None:
                visit(child["draftId"])
        visited.add(draft_id)
        order.append(draft_id)

    visit(request.targetDraftId)
    hashes: dict[str, str] = {}
    steps = []
    for draft_id in order:
        state = states[draft_id]
        digest = source_hash(state["finalSource"])
        imports = []
        for imported in dependencies[draft_id]:
            child_id = imported.get("draftId")
            item = {
                "exportName": imported["exportName"],
                "alias": imported["alias"],
                "coordinate": imported["coordinate"],
                "moduleHash": hashes[child_id] if child_id else imported["moduleHash"],
            }
            item["draftId" if child_id else "geometryVersionId"] = (
                child_id if child_id else imported["geometryVersionId"]
            )
            imports.append(item)
        imports.sort(key=lambda item: (item["alias"], item["exportName"], item["coordinate"]))
        digest_module = module_hash(state["coordinate"], digest, imports)
        hashes[draft_id] = digest_module
        steps.append(
            {
                "draftId": draft_id,
                "baseGeometryVersionId": state["base"][0].id if state["base"] else None,
                "repositoryId": state["repository_id"],
                "repository": state["repository"],
                "package": state["package"],
                "version": state["version"],
                "coordinate": state["coordinate"],
                "localCoordinate": state["localCoordinate"],
                "description": state["description"],
                "source": state["finalSource"],
                "sourceHash": digest,
                "moduleHash": digest_module,
                "exports": state["finalAnalysis"]["exports"],
                "imports": imports,
            }
        )
    replacements = [
        {
            "draftId": step["draftId"],
            "localCoordinate": step["localCoordinate"],
            "coordinate": step["coordinate"],
        }
        for step in steps
    ]
    content = {"steps": steps, "replacements": replacements}
    plan_hash = hashlib.sha256(
        json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {"planHash": plan_hash, **content}


async def _publish_owner_id(
    db: AsyncSession,
    request: GeometryPublishPlanRequest,
    *,
    user: Any,
) -> str:
    target = next(draft for draft in request.drafts if draft.draftId == request.targetDraftId)
    if target.baseGeometryVersionId is None:
        return user.id
    row = (await _version_rows(db, {target.baseGeometryVersionId})).get(target.baseGeometryVersionId)
    if row is None or (not is_admin_user(user) and row[2].user_id != user.id):
        raise _bad("Geometry draft base version was not found.", code=404)
    if row[2].user_id is None:
        raise _bad("Geometry owner is no longer available.", code=409)
    return row[2].user_id


async def _raise_stale_publish_plan(
    db: AsyncSession,
    request: GeometryPublishPlanRequest,
    revised_plan: dict[str, Any],
) -> None:
    target = next(step for step in revised_plan["steps"] if step["draftId"] == request.targetDraftId)
    raise GeometryVersionConflict(
        draft_id=request.targetDraftId,
        coordinate=target["coordinate"],
        suggested_version=target["version"],
        revised_plan=revised_plan,
    )


async def publish(
    db: AsyncSession,
    request: GeometryPublishRequest,
    *,
    user: Any,
) -> dict[str, Any]:
    _validate_publish_request(request)
    plan_request = GeometryPublishPlanRequest.model_validate(request.model_dump(exclude={"planHash"}))
    owner_id = await _publish_owner_id(db, plan_request, user=user)
    await _lock_geometry_owner(db, owner_id)
    plan = await plan_publish(db, plan_request, user=user)
    if plan["planHash"] != request.planHash:
        await _raise_stale_publish_plan(db, plan_request, plan)
    published_ids: dict[str, int] = {}
    try:
        for step in plan["steps"]:
            repository = await db.scalar(
                select(GeometryRepository)
                .where(
                    GeometryRepository.namespace == step["coordinate"].split("/")[1],
                    GeometryRepository.slug == step["repository"],
                )
                .with_for_update()
            )
            if repository is None:
                repository = GeometryRepository(
                    user_id=owner_id,
                    namespace=step["coordinate"].split("/")[1],
                    slug=step["repository"],
                    description=None,
                )
                db.add(repository)
                await db.flush()
            elif repository.user_id != owner_id or repository.archived_at is not None:
                raise _bad("Geometry repository is unavailable during publish.", code=409)
            package = await db.scalar(
                select(GeometryPackage).where(
                    GeometryPackage.repository_id == repository.id,
                    GeometryPackage.name == step["package"],
                )
            )
            if package is None:
                package = GeometryPackage(repository_id=repository.id, name=step["package"])
                db.add(package)
                await db.flush()
            major, minor, patch = _version_tuple(step["version"])
            version = GeometryVersion(
                package_id=package.id,
                version_major=major,
                version_minor=minor,
                version_patch=patch,
                description=step["description"],
                source=step["source"],
                source_hash=step["sourceHash"],
                module_hash=step["moduleHash"],
                module_format_version=3,
                cad_api_version=5,
            )
            db.add(version)
            await db.flush()
            for imported in step["imports"]:
                imported_id = (
                    published_ids[imported["draftId"]]
                    if imported.get("draftId") is not None
                    else imported["geometryVersionId"]
                )
                db.add(
                    GeometryImport(
                        importer_geometry_version_id=version.id,
                        imported_geometry_version_id=imported_id,
                        export_name=imported["exportName"],
                        alias=imported["alias"],
                    )
                )
            published_ids[step["draftId"]] = version.id
        await db.flush()
    except IntegrityError as error:
        await db.rollback()
        owner_id = await _publish_owner_id(db, plan_request, user=user)
        await _lock_geometry_owner(db, owner_id)
        revised = await plan_publish(db, plan_request, user=user)
        if revised["planHash"] != plan["planHash"]:
            await _raise_stale_publish_plan(db, plan_request, revised)
        raise _bad(
            "Geometry publish conflicted with another database change; request a new plan.",
            code=409,
        ) from error

    rows = await _version_rows(db, set(published_ids.values()))
    response = {
        "planHash": plan["planHash"],
        "published": [
            _version_response(rows[published_ids[step["draftId"]]])
            for step in plan["steps"]
        ],
        "replacements": plan["replacements"],
    }
    await db.commit()
    return response
