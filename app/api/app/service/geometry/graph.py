from __future__ import annotations

from typing import Any

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db import GeometryImport, GeometryPackage, GeometryRepository, GeometryVersion
from models import GeometryModuleSnapshot, GeometrySnapshot, GeometrySnapshotImport
from service.geometry.source import (
    MAX_DEPTH,
    MAX_ENTRY_IMPORTS,
    MAX_GRAPH_SOURCE_BYTES,
    MAX_IMPORTS,
    MAX_MODULES,
    _bad,
    _coordinate_version_is_bounded,
    _row_coordinate,
    _validate_alias,
    analyze_geometry_source,
    module_hash,
    source_hash,
    COORDINATE_RE,
)


async def _version_rows(
    db: AsyncSession,
    ids: set[int],
    *,
    lock: bool = False,
) -> dict[int, tuple[GeometryVersion, GeometryPackage, GeometryRepository, str]]:
    if not ids:
        return {}
    statement = (
        select(GeometryVersion, GeometryPackage, GeometryRepository, GeometryRepository.namespace)
        .join(GeometryPackage, GeometryVersion.package_id == GeometryPackage.id)
        .join(GeometryRepository, GeometryPackage.repository_id == GeometryRepository.id)
        .where(GeometryVersion.id.in_(ids))
    )
    if lock:
        statement = statement.with_for_update(of=GeometryVersion)
    rows = (await db.execute(statement)).all()
    return {
        version.id: (version, package, repository, namespace)
        for version, package, repository, namespace in rows
    }


async def _resolve_coordinate(
    db: AsyncSession,
    coordinate: str,
    *,
    owner_id: str | None,
) -> tuple[GeometryVersion, GeometryPackage, GeometryRepository, str] | None:
    match = COORDINATE_RE.fullmatch(coordinate)
    if match is None or not _coordinate_version_is_bounded(coordinate):
        return None
    statement = (
        select(GeometryVersion, GeometryPackage, GeometryRepository, GeometryRepository.namespace)
        .join(GeometryPackage, GeometryVersion.package_id == GeometryPackage.id)
        .join(GeometryRepository, GeometryPackage.repository_id == GeometryRepository.id)
        .where(
            GeometryRepository.namespace == match.group("namespace"),
            GeometryRepository.slug == match.group("repository"),
            GeometryPackage.name == match.group("package"),
            GeometryVersion.version_major == int(match.group("major")),
            GeometryVersion.version_minor == int(match.group("minor")),
            GeometryVersion.version_patch == int(match.group("patch")),
        )
    )
    if owner_id is not None:
        statement = statement.where(GeometryRepository.user_id == owner_id)
    row = (await db.execute(statement)).first()
    return tuple(row) if row is not None else None


async def _load_graph(
    db: AsyncSession,
    root_ids: set[int],
    *,
    owner_id: str | None,
) -> tuple[
    dict[int, tuple[GeometryVersion, GeometryPackage, GeometryRepository, str]],
    dict[int, list[int]],
    dict[int, list[tuple[str, str, int]]],
]:
    if len(root_ids) > MAX_ENTRY_IMPORTS:
        raise _bad(f"Geometry entry may import at most {MAX_ENTRY_IMPORTS} modules.")
    edges: dict[int, list[int]] = {}
    bindings: dict[int, list[tuple[str, str, int]]] = {}
    frontier = set(root_ids)
    queried: set[int] = set()
    all_ids = set(root_ids)
    while frontier:
        current = frontier - queried
        if not current:
            break
        queried.update(current)
        edge_rows = (
            await db.execute(
                select(
                    GeometryImport.importer_geometry_version_id,
                    GeometryImport.imported_geometry_version_id,
                    GeometryImport.export_name,
                    GeometryImport.alias,
                ).where(GeometryImport.importer_geometry_version_id.in_(current))
            )
        ).all()
        next_frontier: set[int] = set()
        for importer_id, imported_id, export_name, alias in edge_rows:
            edges.setdefault(importer_id, []).append(imported_id)
            bindings.setdefault(importer_id, []).append((export_name, alias, imported_id))
            next_frontier.add(imported_id)
            all_ids.add(imported_id)
        frontier = next_frontier
        if len(all_ids) > MAX_MODULES:
            raise _bad(f"Geometry graph may contain at most {MAX_MODULES} modules.")

    rows = await _version_rows(db, all_ids)
    if len(rows) != len(all_ids):
        raise _bad("Geometry dependency graph contains an unresolved version.")
    if any(row[2].user_id != owner_id for row in rows.values()):
        raise _bad("Geometry dependencies must have the same owner.")
    for version_id in rows:
        edges.setdefault(version_id, [])
        bindings.setdefault(version_id, [])
        if len(bindings[version_id]) > MAX_IMPORTS:
            raise _bad(f"Geometry modules may import at most {MAX_IMPORTS} bindings.")
    _assert_acyclic(edges)
    _assert_max_depth(edges, root_ids)
    return rows, edges, bindings


def _assert_acyclic(
    edges: dict[Any, list[Any]],
    *,
    error_code: int = status.HTTP_400_BAD_REQUEST,
) -> None:
    visiting: set[Any] = set()
    visited: set[Any] = set()

    def visit(node: Any) -> None:
        if node in visiting:
            raise _bad("Geometry dependency graph contains a cycle.", code=error_code)
        if node in visited:
            return
        visiting.add(node)
        for child in edges.get(node, []):
            visit(child)
        visiting.remove(node)
        visited.add(node)

    for node in edges:
        visit(node)


def _assert_max_depth(
    edges: dict[Any, list[Any]],
    roots: set[Any],
    *,
    error_code: int = status.HTTP_400_BAD_REQUEST,
) -> None:
    memo: dict[Any, int] = {}
    visiting: set[Any] = set()

    def longest_path(node: Any) -> int:
        cached = memo.get(node)
        if cached is not None:
            return cached
        if node in visiting:
            raise _bad("Geometry dependency graph contains a cycle.", code=error_code)
        visiting.add(node)
        depth = 1
        for child in edges.get(node, []):
            depth = max(depth, 1 + longest_path(child))
            if depth > MAX_DEPTH:
                raise _bad(f"Geometry graph depth exceeds {MAX_DEPTH}.", code=error_code)
        visiting.remove(node)
        memo[node] = depth
        return depth

    for root in roots:
        longest_path(root)


def _snapshot_modules(
    rows: dict[int, tuple[GeometryVersion, GeometryPackage, GeometryRepository, str]],
    edges: dict[int, list[int]],
    bindings: dict[int, list[tuple[str, str, int]]],
) -> list[GeometryModuleSnapshot]:
    total_bytes = sum(len(row[0].source.encode("utf-8")) for row in rows.values())
    if total_bytes > MAX_GRAPH_SOURCE_BYTES:
        raise _bad("Geometry graph source exceeds 8 MiB.")
    analyses = {
        version_id: analyze_geometry_source(row[0].source)
        for version_id, row in rows.items()
    }
    modules: list[GeometryModuleSnapshot] = []
    for version_id, row in rows.items():
        version = row[0]
        coordinate = _row_coordinate(row)
        digest = source_hash(version.source)
        if digest != version.source_hash:
            raise _bad(f"Stored Geometry source hash is invalid: {coordinate}")
        projected = sorted(
            bindings[version_id],
            key=lambda item: (item[1], item[0], _row_coordinate(rows[item[2]])),
        )
        source_bindings = [
            (item["exportName"], item["alias"], item["coordinate"])
            for item in analyses[version_id]["imports"]
        ]
        projected_bindings = [
            (export_name, alias, _row_coordinate(rows[child_id]))
            for export_name, alias, child_id in projected
        ]
        if source_bindings != projected_bindings:
            raise _bad(f"Stored Geometry import projection is invalid: {coordinate}")
        imports = []
        for export_name, alias, child_id in projected:
            if export_name not in analyses[child_id]["exports"]:
                raise _bad(f"Imported Geometry export does not exist: {export_name}")
            imports.append(
                GeometrySnapshotImport(
                    exportName=export_name,
                    alias=alias,
                    geometryVersionId=child_id,
                    coordinate=_row_coordinate(rows[child_id]),
                    moduleHash=rows[child_id][0].module_hash,
                )
            )
        expected_hash = module_hash(
            coordinate,
            digest,
            [
                {
                    "exportName": item.exportName,
                    "alias": item.alias,
                    "coordinate": item.coordinate,
                    "moduleHash": item.moduleHash,
                }
                for item in imports
            ],
        )
        if expected_hash != version.module_hash:
            raise _bad(f"Stored Geometry module hash is invalid: {coordinate}")
        modules.append(
            GeometryModuleSnapshot(
                geometryVersionId=version_id,
                coordinate=coordinate,
                moduleFormatVersion=4,
                cadApiVersion=7,
                description=version.description,
                source=version.source,
                sourceHash=digest,
                moduleHash=expected_hash,
                imports=imports,
            )
        )
    return sorted(modules, key=lambda item: item.coordinate)


async def build_snapshot(
    db: AsyncSession,
    entry_imports: list[tuple[str, str, int]],
    *,
    owner_id: str | None,
) -> GeometrySnapshot:
    aliases = [alias for _, alias, _ in entry_imports]
    if len(aliases) != len(set(aliases)):
        raise _bad("Experiment geometry.tsx import aliases must be unique.")
    root_ids = {version_id for _, _, version_id in entry_imports}
    rows, edges, bindings = await _load_graph(db, root_ids, owner_id=owner_id)
    modules = _snapshot_modules(rows, edges, bindings)
    exports_by_id = {
        version_id: set(analyze_geometry_source(row[0].source)["exports"])
        for version_id, row in rows.items()
    }
    result = []
    for export_name, alias, version_id in sorted(
        entry_imports,
        key=lambda item: (item[1], item[0], _row_coordinate(rows[item[2]])),
    ):
        _validate_alias(export_name)
        _validate_alias(alias)
        if export_name not in exports_by_id[version_id]:
            raise _bad(f"Imported Geometry export does not exist: {export_name}")
        result.append(
            GeometrySnapshotImport(
                exportName=export_name,
                alias=alias,
                geometryVersionId=version_id,
                coordinate=_row_coordinate(rows[version_id]),
                moduleHash=rows[version_id][0].module_hash,
            )
        )
    return GeometrySnapshot(schemaVersion=2, entryImports=result, modules=modules)


async def build_snapshot_from_entry_source(
    db: AsyncSession,
    source: str,
    *,
    owner_id: str | None,
) -> GeometrySnapshot:
    analysis = analyze_geometry_source(source, allow_empty=True)
    resolved: dict[str, tuple[GeometryVersion, GeometryPackage, GeometryRepository, str]] = {}
    for imported in analysis["imports"]:
        coordinate = imported["coordinate"]
        if coordinate not in resolved:
            row = await _resolve_coordinate(db, coordinate, owner_id=owner_id)
            if row is None:
                raise _bad(f"Geometry import was not found: {coordinate}", code=status.HTTP_404_NOT_FOUND)
            resolved[coordinate] = row
    return await build_snapshot(
        db,
        [
            (
                imported["exportName"],
                imported["alias"],
                resolved[imported["coordinate"]][0].id,
            )
            for imported in analysis["imports"]
        ],
        owner_id=owner_id,
    )
