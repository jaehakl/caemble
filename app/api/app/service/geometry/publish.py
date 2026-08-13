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
    build_snapshot,
)
from service.geometry.manager import _lock_geometry_owner, _version_response
from service.geometry.source import (
    GEOMETRY_SEMVER_COMPONENT_MAX,
    MAX_DEPTH,
    MAX_GRAPH_SOURCE_BYTES,
    MAX_MODULES,
    MAX_MODULE_SOURCE_BYTES,
    SEMVER_RE,
    _bad,
    _bump,
    _coordinate,
    _row_coordinate,
    _semver,
    _semver_component_is_bounded,
    _validate_alias,
    _validate_sha256,
    _validate_slug,
    _version_tuple,
    analyze_geometry_source,
    module_hash,
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
        raise _bad(
            "draftId values must be unique.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if request.targetDraftId not in set(draft_ids):
        raise _bad(
            "targetDraftId must identify a draft.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    for draft in request.drafts:
        _validate_slug(draft.repository, "repository slug")
        _validate_slug(draft.package, "package name")
        if draft.baseGeometryVersionId is None and draft.version is None:
            raise _bad(
                "A new Geometry draft requires version.",
                code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if draft.baseGeometryVersionId is not None and draft.version is not None:
            raise _bad(
                "An existing Geometry draft uses bump instead of version.",
                code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        try:
            source_size = len(draft.source.encode("utf-8"))
        except UnicodeEncodeError as error:
            raise _bad(
                "Geometry module source must contain valid UTF-8 text.",
                code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            ) from error
        if source_size > MAX_MODULE_SOURCE_BYTES:
            raise _bad(
                "Geometry module source exceeds 1 MiB.",
                code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if draft.version is not None:
            if SEMVER_RE.fullmatch(draft.version) is None:
                raise _bad(
                    "Geometry version format is invalid.",
                    code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            if any(
                not _semver_component_is_bounded(component)
                for component in draft.version.split(".")
            ):
                raise _bad(
                    f"Geometry version components must not exceed {GEOMETRY_SEMVER_COMPONENT_MAX}.",
                    code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )

    aliases = [root.alias for root in request.currentRoots]
    if len(aliases) != len(set(aliases)):
        raise _bad(
            "Root aliases must be unique.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    published_ids: list[int] = []
    root_draft_ids: list[str] = []
    for root in request.currentRoots:
        _validate_alias(root.alias)
        if (root.geometryVersionId is None) == (root.draftId is None):
            raise _bad(
                "A root requires exactly one of geometryVersionId or draftId.",
                code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if root.geometryVersionId is not None:
            published_ids.append(root.geometryVersionId)
        if root.draftId is not None:
            root_draft_ids.append(root.draftId)
    if len(published_ids) != len(set(published_ids)) or len(root_draft_ids) != len(
        set(root_draft_ids)
    ):
        raise _bad(
            "Geometry roots must reference unique versions or drafts.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if not set(root_draft_ids).issubset(draft_ids):
        raise _bad(
            "Geometry root draftId must identify a draft.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if request.mode == "publish-only" and root_draft_ids:
        raise _bad(
            "publish-only roots cannot reference unpublished drafts.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )


async def plan_publish(
    db: AsyncSession,
    request: GeometryPublishPlanRequest,
    *,
    user: Any,
) -> dict[str, Any]:
    _validate_publish_request(request)
    draft_models = {draft.draftId: draft for draft in request.drafts}
    base_ids = {draft.baseGeometryVersionId for draft in request.drafts if draft.baseGeometryVersionId}
    base_rows = await _version_rows(db, set(base_ids))
    if len(base_rows) != len(base_ids):
        raise _bad("A Geometry draft base version was not found.", code=status.HTTP_404_NOT_FOUND)

    target = draft_models[request.targetDraftId]
    target_base = base_rows.get(target.baseGeometryVersionId) if target.baseGeometryVersionId else None
    graph_owner_id = target_base[2].user_id if target_base else user.id
    if graph_owner_id != user.id and not is_admin_user(user):
        raise _bad("Geometry draft base version was not found.", code=status.HTTP_404_NOT_FOUND)
    owner = await db.get(User, graph_owner_id)
    if owner is None or owner.geometry_namespace is None:
        raise _bad("Set a Geometry namespace before publishing.", code=status.HTTP_409_CONFLICT)

    owned_repositories = list(
        (
            await db.execute(
                select(GeometryRepository).where(GeometryRepository.user_id == graph_owner_id)
            )
        ).scalars()
    )
    repositories_by_id = {repository.id: repository for repository in owned_repositories}
    current_repositories_by_slug = {
        repository.slug: repository
        for repository in owned_repositories
        if repository.namespace == owner.geometry_namespace
    }
    states: dict[str, dict[str, Any]] = {}
    base_to_draft: dict[int, str] = {}
    for draft in request.drafts:
        base_row = base_rows.get(draft.baseGeometryVersionId) if draft.baseGeometryVersionId else None
        if base_row:
            if base_row[2].archived_at is not None or base_row[0].archived_at is not None:
                raise _bad(f"Geometry draft base is archived: {draft.draftId}")
            if base_row[2].user_id != graph_owner_id:
                raise _bad("All Geometry drafts in a publish plan must have the same owner.")
            if base_row[2].slug != draft.repository or base_row[1].name != draft.package:
                raise _bad(f"Draft {draft.draftId} repository/package does not match its base version.")
            if draft.repositoryId is not None and draft.repositoryId != base_row[2].id:
                raise _bad(f"Draft {draft.draftId} repositoryId does not match its base version.")
            if draft.baseGeometryVersionId in base_to_draft:
                raise _bad("Only one draft may target each published Geometry version.")
            base_to_draft[draft.baseGeometryVersionId] = draft.draftId
            latest = await db.scalar(
                select(GeometryVersion)
                .where(GeometryVersion.package_id == base_row[1].id)
                .order_by(
                    GeometryVersion.version_major.desc(),
                    GeometryVersion.version_minor.desc(),
                    GeometryVersion.version_patch.desc(),
                )
                .limit(1)
            )
            version_tuple = _bump(
                (latest.version_major, latest.version_minor, latest.version_patch),
                draft.bump,
            )
        else:
            repository = (
                repositories_by_id.get(draft.repositoryId)
                if draft.repositoryId is not None
                else current_repositories_by_slug.get(draft.repository)
            )
            if draft.repositoryId is not None and repository is None:
                raise _bad("Geometry repository not found.", code=status.HTTP_404_NOT_FOUND)
            if repository is not None and repository.slug != draft.repository:
                raise _bad(f"Draft {draft.draftId} repository does not match repositoryId.")
            if repository is not None and repository.archived_at is not None:
                raise _bad(f"Geometry repository is archived: {draft.repository}")
            version_tuple = _version_tuple(draft.version or "")
        repository = base_row[2] if base_row else repository
        namespace = repository.namespace if repository is not None else owner.geometry_namespace
        version_text = ".".join(str(part) for part in version_tuple)
        states[draft.draftId] = {
            "draft": draft,
            "base": base_row,
            "repository_id": repository.id if repository is not None else None,
            "namespace": namespace,
            "repository": draft.repository,
            "package": draft.package,
            "version_tuple": version_tuple,
            "version": version_text,
            "coordinate": _coordinate(namespace, draft.repository, draft.package, version_text),
            "description": draft.description,
            "source": draft.source,
            "original_source": draft.source,
            "generated": False,
        }
    draft_replacements = {
        _row_coordinate(state["base"]): state["coordinate"]
        for state in states.values()
        if state["base"] is not None
    }

    selected = _draft_dependency_closure(states, {request.targetDraftId}, draft_replacements)
    selected.update(
        _draft_dependency_closure(
            states,
            {root.draftId for root in request.currentRoots if root.draftId},
            draft_replacements,
        )
    )

    root_version_ids = {root.geometryVersionId for root in request.currentRoots if root.geometryVersionId}
    root_rows: dict[int, tuple[GeometryVersion, GeometryPackage, GeometryRepository, str]] = {}
    root_edges: dict[int, list[int]] = {}
    if root_version_ids:
        root_rows, root_edges = await _load_graph(db, set(root_version_ids), owner_id=graph_owner_id)
    if request.mode == "publish-and-apply":
        coordinate_to_drafts: dict[str, list[str]] = {}
        base_coordinate_to_drafts: dict[str, list[str]] = {}
        for draft_id, state in states.items():
            coordinate_to_drafts.setdefault(state["coordinate"], []).append(draft_id)
            if state["base"] is not None:
                base_coordinate_to_drafts.setdefault(_row_coordinate(state["base"]), []).append(
                    draft_id
                )
        local_edges: dict[str, set[str]] = {}
        local_imports: dict[str, list[str]] = {}
        for draft_id, state in states.items():
            try:
                imported_coordinates = [
                    imported_coordinate
                    for imported_coordinate, _, _ in analyze_geometry_source(state["source"])
                ]
            except HTTPException:
                if draft_id in selected:
                    raise
                continue
            children: set[str] = set()
            local_imports[draft_id] = imported_coordinates
            for imported_coordinate in imported_coordinates:
                child_ids = base_coordinate_to_drafts.get(imported_coordinate) or coordinate_to_drafts.get(
                    draft_replacements.get(imported_coordinate, imported_coordinate),
                    [],
                )
                if len(child_ids) == 1:
                    children.add(child_ids[0])
                elif len(child_ids) > 1 and draft_id in selected:
                    raise _bad(f"Geometry import matches multiple drafts: {imported_coordinate}")
            local_edges[draft_id] = children

        base_to_overlay = {
            state["base"][0].id: draft_id
            for draft_id, state in states.items()
            if state["base"] is not None
        }
        published_coordinate_to_id = {
            _row_coordinate(row): version_id for version_id, row in root_rows.items()
        }
        root_reachable_drafts: set[str] = set()
        visited_published: set[int] = set()
        pending: list[tuple[str, str | int]] = [
            ("published", root.geometryVersionId)
            for root in request.currentRoots
            if root.geometryVersionId is not None
        ]
        pending.extend(
            ("draft", root.draftId)
            for root in request.currentRoots
            if root.draftId is not None
        )
        while pending:
            kind, identifier = pending.pop()
            if kind == "published":
                version_id = int(identifier)
                if version_id in visited_published:
                    continue
                visited_published.add(version_id)
                overlay_id = base_to_overlay.get(version_id)
                if overlay_id is not None:
                    pending.append(("draft", overlay_id))
                else:
                    pending.extend(("published", child_id) for child_id in root_edges.get(version_id, []))
                continue
            draft_id = str(identifier)
            if draft_id in root_reachable_drafts:
                continue
            root_reachable_drafts.add(draft_id)
            for imported_coordinate in local_imports.get(draft_id, []):
                child_ids = base_coordinate_to_drafts.get(imported_coordinate) or coordinate_to_drafts.get(
                    draft_replacements.get(imported_coordinate, imported_coordinate),
                    [],
                )
                if len(child_ids) == 1:
                    pending.append(("draft", child_ids[0]))
                    continue
                published_id = published_coordinate_to_id.get(imported_coordinate)
                if published_id is not None:
                    pending.append(("published", published_id))

        applicable = set(selected)
        while True:
            importers = {
                draft_id
                for draft_id in root_reachable_drafts - applicable
                if local_edges.get(draft_id, set()) & applicable
            }
            if not importers:
                break
            applicable.update(importers)
        selected.update(applicable & root_reachable_drafts)
        selected.update(_draft_dependency_closure(states, selected, draft_replacements))

        changed = {
            state["base"][0].id: draft_id
            for draft_id, state in states.items()
            if draft_id in selected and state["base"] is not None
        }
        while True:
            added = False
            for parent_id, child_ids in root_edges.items():
                if parent_id in changed or not any(child_id in changed for child_id in child_ids):
                    continue
                existing_draft_id = base_to_draft.get(parent_id)
                if existing_draft_id:
                    if existing_draft_id not in selected:
                        continue
                    selected.update(_draft_dependency_closure(states, {existing_draft_id}, draft_replacements))
                    changed[parent_id] = existing_draft_id
                else:
                    base_row = root_rows[parent_id]
                    generated_id = f"ancestor:{parent_id}"
                    latest = await db.scalar(
                        select(GeometryVersion)
                        .where(GeometryVersion.package_id == base_row[1].id)
                        .order_by(
                            GeometryVersion.version_major.desc(),
                            GeometryVersion.version_minor.desc(),
                            GeometryVersion.version_patch.desc(),
                        )
                        .limit(1)
                    )
                    version_tuple = _bump(
                        (
                            latest.version_major,
                            latest.version_minor,
                            latest.version_patch,
                        ),
                        "patch",
                    )
                    version_text = ".".join(str(part) for part in version_tuple)
                    states[generated_id] = {
                        "draft": None,
                        "base": base_row,
                        "repository_id": base_row[2].id,
                        "namespace": base_row[2].namespace,
                        "repository": base_row[2].slug,
                        "package": base_row[1].name,
                        "version_tuple": version_tuple,
                        "version": version_text,
                        "coordinate": _coordinate(
                            base_row[2].namespace,
                            base_row[2].slug,
                            base_row[1].name,
                            version_text,
                        ),
                        "description": base_row[0].description,
                        "source": base_row[0].source,
                        "original_source": base_row[0].source,
                        "generated": True,
                    }
                    selected.add(generated_id)
                    changed[parent_id] = generated_id
                    await _assert_version_available(
                        db,
                        states[generated_id],
                        draft_id=generated_id,
                        owner_id=graph_owner_id,
                    )
                added = True
            if not added:
                break

    tentative_coordinates = {
        draft_id: states[draft_id]["coordinate"] for draft_id in selected
    }
    await _allocate_selected_existing_versions(
        db,
        states,
        selected,
    )
    draft_replacements = {
        _row_coordinate(states[draft_id]["base"]): states[draft_id]["coordinate"]
        for draft_id in selected
        if states[draft_id]["base"] is not None
    }
    tentative_targets: dict[str, set[str]] = {}
    for draft_id, tentative_coordinate in tentative_coordinates.items():
        final_coordinate = states[draft_id]["coordinate"]
        if tentative_coordinate != final_coordinate:
            tentative_targets.setdefault(tentative_coordinate, set()).add(final_coordinate)
    draft_replacements.update(
        {
            tentative_coordinate: next(iter(final_coordinates))
            for tentative_coordinate, final_coordinates in tentative_targets.items()
            if len(final_coordinates) == 1
        }
    )
    selected_states = {draft_id: states[draft_id] for draft_id in selected}
    for state in selected_states.values():
        state["source"] = _rewrite_imports(state["original_source"], draft_replacements)

    selected = _draft_dependency_closure(selected_states, selected, draft_replacements)
    selected_states = {draft_id: states[draft_id] for draft_id in selected}
    _assert_unique_planned_coordinates(selected_states)
    for draft_id, state in selected_states.items():
        await _assert_version_available(db, state, draft_id=draft_id, owner_id=graph_owner_id)
    if len(selected_states) > MAX_MODULES:
        raise _bad(f"A publish plan may contain at most {MAX_MODULES} modules.")
    if sum(len(state["source"].encode("utf-8")) for state in selected_states.values()) > MAX_GRAPH_SOURCE_BYTES:
        raise _bad("Publish plan source exceeds 8 MiB.")
    _assert_unique_planned_coordinates(selected_states)
    coordinate_to_draft = {state["coordinate"]: draft_id for draft_id, state in selected_states.items()}
    dependencies: dict[str, list[dict[str, Any]]] = {}
    for draft_id, state in selected_states.items():
        dependencies[draft_id] = []
        for imported_coordinate, _, _ in analyze_geometry_source(state["source"]):
            child_draft_id = coordinate_to_draft.get(imported_coordinate)
            if child_draft_id:
                dependencies[draft_id].append(
                    {"draftId": child_draft_id, "coordinate": imported_coordinate}
                )
                continue
            imported = await _resolve_coordinate(db, imported_coordinate, owner_id=graph_owner_id)
            if imported is None:
                raise _bad(f"Geometry import cannot be resolved: {imported_coordinate}")
            dependencies[draft_id].append(
                {
                    "geometryVersionId": imported[0].id,
                    "coordinate": imported_coordinate,
                    "moduleHash": imported[0].module_hash,
                }
            )

    external_ids = {
        dependency["geometryVersionId"]
        for items in dependencies.values()
        for dependency in items
        if dependency.get("geometryVersionId") is not None
    }
    external_rows: dict[int, tuple[GeometryVersion, GeometryPackage, GeometryRepository, str]] = {}
    external_edges: dict[int, list[int]] = {}
    if external_ids:
        external_rows, external_edges = await _load_graph(
            db,
            external_ids,
            owner_id=graph_owner_id,
        )
        _snapshot_modules(external_rows, external_edges)
    if len(selected_states) + len(external_rows) > MAX_MODULES:
        raise _bad(f"Geometry graph may contain at most {MAX_MODULES} modules.")
    total_graph_source = sum(
        len(state["source"].encode("utf-8")) for state in selected_states.values()
    ) + sum(len(row[0].source.encode("utf-8")) for row in external_rows.values())
    if total_graph_source > MAX_GRAPH_SOURCE_BYTES:
        raise _bad("Geometry graph source exceeds 8 MiB.")

    dependency_edges = {
        draft_id: [
            item["draftId"] if item.get("draftId") else item["geometryVersionId"]
            for item in items
        ]
        for draft_id, items in dependencies.items()
    }
    combined_edges: dict[Any, list[Any]] = {**external_edges, **dependency_edges}
    _assert_acyclic(combined_edges)
    _assert_max_depth(combined_edges, set(selected_states))
    order: list[str] = []
    visited: set[str] = set()

    def visit(draft_id: str, depth: int = 0) -> None:
        if depth > MAX_DEPTH:
            raise _bad(f"Geometry graph depth exceeds {MAX_DEPTH}.")
        if draft_id in visited:
            return
        planned_children = [item for item in dependency_edges[draft_id] if isinstance(item, str)]
        for child_id in sorted(planned_children, key=lambda item: selected_states[item]["coordinate"]):
            visit(child_id, depth + 1)
        visited.add(draft_id)
        order.append(draft_id)

    for draft_id in sorted(selected_states, key=lambda item: selected_states[item]["coordinate"]):
        visit(draft_id)

    steps = []
    hashes: dict[str, str] = {}
    for draft_id in order:
        state = selected_states[draft_id]
        digest = source_hash(state["source"])
        imports = []
        for dependency in dependencies[draft_id]:
            child_id = dependency.get("draftId")
            child_hash = hashes[child_id] if child_id else dependency["moduleHash"]
            planned_import = {
                "coordinate": dependency["coordinate"],
                "moduleHash": child_hash,
            }
            planned_import[
                "draftId" if child_id is not None else "geometryVersionId"
            ] = child_id if child_id is not None else dependency["geometryVersionId"]
            imports.append(planned_import)
        digest_module = module_hash(
            state["coordinate"],
            digest,
            [{"coordinate": item["coordinate"], "moduleHash": item["moduleHash"]} for item in imports],
        )
        hashes[draft_id] = digest_module
        steps.append(
            {
                "draftId": draft_id,
                "baseGeometryVersionId": state["base"][0].id if state["base"] else None,
                "repository": state["repository"],
                "package": state["package"],
                "version": state["version"],
                "coordinate": state["coordinate"],
                "description": state["description"],
                "source": state["source"],
                "sourceHash": digest,
                "moduleHash": digest_module,
                "imports": sorted(imports, key=lambda item: item["coordinate"]),
                "generated": state["generated"],
            }
        )

    planned_roots = []
    replacements = []
    changed_lookup = (
        {
            state["base"][0].id: draft_id
            for draft_id, state in selected_states.items()
            if state["base"] is not None
        }
        if request.mode == "publish-and-apply"
        else {}
    )
    all_root_rows = await _version_rows(db, set(root_version_ids))
    for root in sorted(request.currentRoots, key=lambda item: item.alias):
        draft_id = root.draftId or changed_lookup.get(root.geometryVersionId)
        if draft_id:
            state = selected_states.get(draft_id)
            if state is None:
                raise _bad(f"Root references a draft outside the publish closure: {draft_id}")
            planned_roots.append(
                {
                    "alias": root.alias,
                    "draftId": draft_id,
                    "coordinate": state["coordinate"],
                    "moduleHash": hashes[draft_id],
                }
            )
            replacement = {
                "alias": root.alias,
                "toDraftId": draft_id,
                "coordinate": state["coordinate"],
            }
            if root.geometryVersionId is not None:
                replacement["fromGeometryVersionId"] = root.geometryVersionId
            replacements.append(replacement)
        else:
            row = all_root_rows.get(root.geometryVersionId)
            if row is None or row[2].user_id != graph_owner_id:
                raise _bad("Geometry root version was not found.", code=status.HTTP_404_NOT_FOUND)
            planned_roots.append(
                {
                    "alias": root.alias,
                    "geometryVersionId": root.geometryVersionId,
                    "coordinate": _row_coordinate(row),
                    "moduleHash": row[0].module_hash,
                }
            )

    content = {
        "mode": request.mode,
        "steps": steps,
        "roots": planned_roots,
        "replacements": replacements,
    }
    plan_digest = hashlib.sha256(
        json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {"planHash": plan_digest, **content}


def _draft_dependency_closure(
    states: dict[str, dict[str, Any]],
    initial: set[str | None],
    replacements: dict[str, str],
) -> set[str]:
    coordinate_to_drafts: dict[str, list[str]] = {}
    base_coordinate_to_drafts: dict[str, list[str]] = {}
    for draft_id, state in states.items():
        coordinate_to_drafts.setdefault(state["coordinate"], []).append(draft_id)
        if state["base"] is not None:
            base_coordinate_to_drafts.setdefault(_row_coordinate(state["base"]), []).append(draft_id)
    selected = {draft_id for draft_id in initial if draft_id is not None}
    pending = list(selected)
    while pending:
        draft_id = pending.pop()
        if draft_id not in states:
            raise _bad(f"Unknown Geometry draft: {draft_id}")
        state = states[draft_id]
        for coordinate, _, _ in analyze_geometry_source(state["source"]):
            child_ids = base_coordinate_to_drafts.get(coordinate) or coordinate_to_drafts.get(
                replacements.get(coordinate, coordinate),
                [],
            )
            if len(child_ids) > 1:
                raise _bad(f"Geometry import matches multiple drafts: {coordinate}")
            child_id = child_ids[0] if child_ids else None
            if child_id and child_id not in selected:
                selected.add(child_id)
                pending.append(child_id)
    return selected


async def _allocate_selected_existing_versions(
    db: AsyncSession,
    states: dict[str, dict[str, Any]],
    selected: set[str],
) -> None:
    grouped: dict[int, list[tuple[tuple[int, int, int], int, str, dict[str, Any]]]] = {}
    for draft_id in selected:
        state = states[draft_id]
        if state["base"] is None:
            continue
        version, package, _, _ = state["base"]
        grouped.setdefault(package.id, []).append(
            (
                (version.version_major, version.version_minor, version.version_patch),
                version.id,
                draft_id,
                state,
            )
        )

    for package_id in sorted(grouped):
        latest = await db.scalar(
            select(GeometryVersion)
            .where(GeometryVersion.package_id == package_id)
            .order_by(
                GeometryVersion.version_major.desc(),
                GeometryVersion.version_minor.desc(),
                GeometryVersion.version_patch.desc(),
            )
            .limit(1)
        )
        cursor = (latest.version_major, latest.version_minor, latest.version_patch)
        for _, _, _, state in sorted(grouped[package_id], key=lambda item: item[:3]):
            bump = state["draft"].bump if state["draft"] is not None else "patch"
            cursor = _bump(cursor, bump)
            version_text = ".".join(str(part) for part in cursor)
            state["version_tuple"] = cursor
            state["version"] = version_text
            state["coordinate"] = _coordinate(
                state["namespace"],
                state["repository"],
                state["package"],
                version_text,
            )


def _assert_unique_planned_coordinates(states: dict[str, dict[str, Any]]) -> None:
    coordinates = [state["coordinate"] for state in states.values()]
    if len(coordinates) != len(set(coordinates)):
        raise _bad("Geometry drafts must have unique proposed coordinates.")


async def _assert_version_available(
    db: AsyncSession,
    state: dict[str, Any],
    *,
    draft_id: str,
    owner_id: str,
) -> None:
    coordinate = state["coordinate"]
    existing = await _resolve_coordinate(db, coordinate, owner_id=owner_id)
    if existing is None:
        return
    package_id = existing[1].id
    latest = await db.scalar(
        select(GeometryVersion)
        .where(GeometryVersion.package_id == package_id)
        .order_by(
            GeometryVersion.version_major.desc(),
            GeometryVersion.version_minor.desc(),
            GeometryVersion.version_patch.desc(),
        )
        .limit(1)
    )
    requested_bump = state["draft"].bump if state["draft"] is not None else "patch"
    suggested = _bump(
        (latest.version_major, latest.version_minor, latest.version_patch),
        requested_bump,
    )
    raise GeometryVersionConflict(
        draft_id=draft_id,
        coordinate=coordinate,
        suggested_version=".".join(str(part) for part in suggested),
    )


def _rewrite_imports(source: str, replacements: dict[str, str]) -> str:
    encoded = source.encode("utf-8")
    edits = [
        (start, end, replacements[coordinate].encode("utf-8"))
        for coordinate, start, end in analyze_geometry_source(source)
        if coordinate in replacements
    ]
    for start, end, replacement in sorted(edits, reverse=True):
        encoded = encoded[:start] + replacement + encoded[end:]
    return encoded.decode("utf-8")


async def _publish_owner_id(
    db: AsyncSession,
    request: GeometryPublishPlanRequest,
    *,
    user: Any,
) -> str:
    target = next(draft for draft in request.drafts if draft.draftId == request.targetDraftId)
    if target.baseGeometryVersionId is None:
        return user.id
    target_row = (await _version_rows(db, {target.baseGeometryVersionId})).get(
        target.baseGeometryVersionId
    )
    if target_row is None or (
        not is_admin_user(user) and target_row[2].user_id != user.id
    ):
        raise _bad("Geometry draft base version was not found.", code=status.HTTP_404_NOT_FOUND)
    if target_row[2].user_id is None:
        raise _bad("Geometry owner is no longer available.", code=status.HTTP_409_CONFLICT)
    return target_row[2].user_id


async def _raise_stale_publish_plan(
    db: AsyncSession,
    request: GeometryPublishPlanRequest,
    revised_plan: dict[str, Any],
) -> None:
    target_draft = next(draft for draft in request.drafts if draft.draftId == request.targetDraftId)
    revised_target = next(
        step for step in revised_plan["steps"] if step["draftId"] == request.targetDraftId
    )
    conflicting_coordinate = revised_target["coordinate"]
    if target_draft.baseGeometryVersionId is not None:
        base_row = (await _version_rows(db, {target_draft.baseGeometryVersionId})).get(
            target_draft.baseGeometryVersionId
        )
        if base_row is not None:
            latest = await db.scalar(
                select(GeometryVersion)
                .where(GeometryVersion.package_id == base_row[1].id)
                .order_by(
                    GeometryVersion.version_major.desc(),
                    GeometryVersion.version_minor.desc(),
                    GeometryVersion.version_patch.desc(),
                )
                .limit(1)
            )
            if latest is not None:
                conflicting_coordinate = _coordinate(
                    base_row[3],
                    base_row[2].slug,
                    base_row[1].name,
                    _semver(latest),
                )
    raise GeometryVersionConflict(
        draft_id=request.targetDraftId,
        coordinate=conflicting_coordinate,
        suggested_version=revised_target["version"],
        revised_plan=revised_plan,
    )


async def publish(
    db: AsyncSession,
    request: GeometryPublishRequest,
    *,
    user: Any,
) -> dict[str, Any]:
    _validate_publish_request(request)
    plan_request = GeometryPublishPlanRequest.model_validate(
        request.model_dump(exclude={"planHash"})
    )
    graph_owner_id = await _publish_owner_id(db, plan_request, user=user)
    await _lock_geometry_owner(db, graph_owner_id)
    plan = await plan_publish(db, plan_request, user=user)
    if plan["planHash"] != request.planHash:
        await _raise_stale_publish_plan(db, plan_request, plan)

    published_ids: dict[str, int] = {}
    try:
        for step in plan["steps"]:
            repository = await db.scalar(
                select(GeometryRepository)
                .where(
                    GeometryRepository.slug == step["repository"],
                    GeometryRepository.namespace == step["coordinate"].split("/")[1],
                )
                .with_for_update()
            )
            if repository is None:
                repository = GeometryRepository(
                    user_id=graph_owner_id,
                    namespace=step["coordinate"].split("/")[1],
                    slug=step["repository"],
                    description=None,
                )
                db.add(repository)
                await db.flush()
            elif repository.archived_at is not None:
                raise _bad(f"Geometry repository is archived: {step['repository']}")
            elif repository.user_id != graph_owner_id:
                raise _bad("Geometry repository owner changed during publish.", code=status.HTTP_409_CONFLICT)
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
                module_format_version=2,
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
                    )
                )
            published_ids[step["draftId"]] = version.id
        await db.flush()
    except IntegrityError as error:
        await db.rollback()
        graph_owner_id = await _publish_owner_id(db, plan_request, user=user)
        await _lock_geometry_owner(db, graph_owner_id)
        revised_plan = await plan_publish(db, plan_request, user=user)
        if revised_plan["planHash"] != plan["planHash"]:
            await _raise_stale_publish_plan(db, plan_request, revised_plan)
        raise _bad(
            "Geometry publish conflicted with another database change; request a new plan.",
            code=status.HTTP_409_CONFLICT,
        ) from error

    final_roots = [
        (
            root["alias"],
            published_ids[root["draftId"]]
            if root.get("draftId") is not None
            else root["geometryVersionId"],
        )
        for root in plan["roots"]
    ]
    owner_id = None
    if final_roots:
        root_row = (await _version_rows(db, {final_roots[0][1]}))[final_roots[0][1]]
        owner_id = root_row[2].user_id
    elif plan["steps"]:
        last_id = published_ids[plan["steps"][-1]["draftId"]]
        owner_id = (await _version_rows(db, {last_id}))[last_id][2].user_id
    else:
        owner_id = user.id
    snapshot = await build_snapshot(db, final_roots, owner_id=owner_id)
    response_rows = await _version_rows(db, set(published_ids.values()))
    response = {
        "planHash": plan["planHash"],
        "published": [
            _version_response(response_rows[published_ids[step["draftId"]]])
            for step in plan["steps"]
        ],
        "roots": [root.model_dump(mode="json") for root in snapshot.roots],
        "geometrySnapshot": snapshot.model_dump(mode="json"),
    }
    await db.commit()
    return response
