from __future__ import annotations

from typing import Any

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db import GeometryImport, GeometryPackage, GeometryRepository, GeometryVersion
from models import (
    GeometryModuleSnapshot,
    GeometryRootBinding,
    GeometrySnapshot,
    GeometrySnapshotImport,
)
from service.geometry.source import (
    COORDINATE_RE,
    MAX_DEPTH,
    MAX_GRAPH_SOURCE_BYTES,
    MAX_IMPORTS,
    MAX_MODULES,
    MAX_MODULE_SOURCE_BYTES,
    MAX_ROOTS,
    _bad,
    _coordinate_version_is_bounded,
    _row_coordinate,
    _validate_alias,
    _validate_coordinate,
    _validate_sha256,
    analyze_geometry_source,
    module_hash,
    source_hash,
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
    result = {}
    for version, package, repository, namespace in rows:
        if namespace is None:
            raise _bad("Geometry owner has no namespace.", code=status.HTTP_409_CONFLICT)
        result[version.id] = (version, package, repository, namespace)
    return result


async def _resolve_coordinate(
    db: AsyncSession,
    coordinate: str,
    *,
    owner_id: str,
) -> tuple[GeometryVersion, GeometryPackage, GeometryRepository, str] | None:
    match = COORDINATE_RE.fullmatch(coordinate)
    if match is None or not _coordinate_version_is_bounded(coordinate):
        return None
    statement = (
        select(GeometryVersion, GeometryPackage, GeometryRepository, GeometryRepository.namespace)
        .join(GeometryPackage, GeometryVersion.package_id == GeometryPackage.id)
        .join(GeometryRepository, GeometryPackage.repository_id == GeometryRepository.id)
        .where(
            GeometryRepository.user_id == owner_id,
            GeometryRepository.namespace == match.group("namespace"),
            GeometryRepository.slug == match.group("repository"),
            GeometryPackage.name == match.group("package"),
            GeometryVersion.version_major == int(match.group("major")),
            GeometryVersion.version_minor == int(match.group("minor")),
            GeometryVersion.version_patch == int(match.group("patch")),
        )
    )
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
]:
    if len(root_ids) > MAX_ROOTS:
        raise _bad(f"Geometry graph may contain at most {MAX_ROOTS} roots.")
    depths = {version_id: 0 for version_id in root_ids}
    edges: dict[int, list[int]] = {}
    frontier = set(root_ids)
    queried: set[int] = set()
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
                ).where(GeometryImport.importer_geometry_version_id.in_(current))
            )
        ).all()
        next_frontier: set[int] = set()
        for importer_id, imported_id in edge_rows:
            edges.setdefault(importer_id, []).append(imported_id)
            depth = depths[importer_id] + 1
            if depth > MAX_DEPTH:
                raise _bad(f"Geometry graph depth exceeds {MAX_DEPTH}.")
            if imported_id not in depths or depth < depths[imported_id]:
                depths[imported_id] = depth
            next_frontier.add(imported_id)
        frontier = next_frontier
        if len(depths) > MAX_MODULES:
            raise _bad(f"Geometry graph may contain at most {MAX_MODULES} modules.")

    rows = await _version_rows(db, set(depths))
    if len(rows) != len(depths):
        raise _bad("Geometry dependency graph contains an unresolved version.")
    if any(row[2].user_id != owner_id for row in rows.values()):
        raise _bad("Geometry dependencies must have the same owner.")
    if len({row[2].namespace for row in rows.values()}) > 1:
        raise _bad("Geometry dependencies must have the same owner namespace.")
    for importer_id in rows:
        edges.setdefault(importer_id, [])
        if len(edges[importer_id]) > MAX_IMPORTS:
            raise _bad(f"Geometry modules may import at most {MAX_IMPORTS} modules.")
    _assert_acyclic(edges)
    _assert_max_depth(edges, root_ids)
    return rows, edges


def _assert_acyclic(edges: dict[Any, list[Any]]) -> None:
    visiting: set[Any] = set()
    visited: set[Any] = set()

    def visit(node: Any) -> None:
        if node in visiting:
            raise _bad("Geometry dependency graph contains a cycle.")
        if node in visited:
            return
        visiting.add(node)
        for child in edges.get(node, []):
            visit(child)
        visiting.remove(node)
        visited.add(node)

    for node in edges:
        visit(node)


def _assert_max_depth(edges: dict[Any, list[Any]], roots: set[Any]) -> None:
    memo: dict[Any, int] = {}
    visiting: set[Any] = set()

    def longest_path(node: Any) -> int:
        cached = memo.get(node)
        if cached is not None:
            return cached
        if node in visiting:
            raise _bad("Geometry dependency graph contains a cycle.")
        visiting.add(node)
        depth = 1
        for child in edges.get(node, []):
            depth = max(depth, 1 + longest_path(child))
            if depth > MAX_DEPTH:
                raise _bad(f"Geometry graph depth exceeds {MAX_DEPTH}.")
        visiting.remove(node)
        memo[node] = depth
        return depth

    for root in roots:
        longest_path(root)


def _snapshot_modules(
    rows: dict[int, tuple[GeometryVersion, GeometryPackage, GeometryRepository, str]],
    edges: dict[int, list[int]],
) -> list[GeometryModuleSnapshot]:
    total_bytes = sum(len(row[0].source.encode("utf-8")) for row in rows.values())
    if total_bytes > MAX_GRAPH_SOURCE_BYTES:
        raise _bad("Geometry graph source exceeds 8 MiB.")
    modules = []
    for version_id, row in rows.items():
        version = row[0]
        coordinate = _row_coordinate(row)
        source_digest = source_hash(version.source)
        if source_digest != version.source_hash:
            raise _bad(f"Stored Geometry source hash is invalid: {coordinate}")
        analyzed = [item[0] for item in analyze_geometry_source(version.source)]
        projected = sorted(_row_coordinate(rows[child_id]) for child_id in edges[version_id])
        if sorted(analyzed) != projected:
            raise _bad(f"Stored Geometry import projection is invalid: {coordinate}")
        imports = [
            GeometrySnapshotImport(
                geometryVersionId=child_id,
                coordinate=_row_coordinate(rows[child_id]),
                moduleHash=rows[child_id][0].module_hash,
            )
            for child_id in sorted(edges[version_id], key=lambda item: _row_coordinate(rows[item]))
        ]
        expected_hash = module_hash(
            coordinate,
            source_digest,
            [{"coordinate": item.coordinate, "moduleHash": item.moduleHash} for item in imports],
        )
        if expected_hash != version.module_hash:
            raise _bad(f"Stored Geometry module hash is invalid: {coordinate}")
        modules.append(
            GeometryModuleSnapshot(
                geometryVersionId=version_id,
                coordinate=coordinate,
                moduleFormatVersion=2,
                cadApiVersion=5,
                description=version.description,
                source=version.source,
                sourceHash=source_digest,
                moduleHash=expected_hash,
                imports=imports,
            )
        )
    return sorted(modules, key=lambda item: item.coordinate)


async def build_snapshot(
    db: AsyncSession,
    roots: list[tuple[str, int]],
    *,
    owner_id: str,
) -> GeometrySnapshot:
    rows, edges = await _load_graph(db, {version_id for _, version_id in roots}, owner_id=owner_id)
    bindings = [
        GeometryRootBinding(
            alias=alias,
            geometryVersionId=version_id,
            coordinate=_row_coordinate(rows[version_id]),
            moduleHash=rows[version_id][0].module_hash,
        )
        for alias, version_id in sorted(roots)
    ]
    return GeometrySnapshot(
        schemaVersion=1,
        roots=bindings,
        modules=_snapshot_modules(rows, edges),
    )


async def validate_snapshot(
    db: AsyncSession,
    snapshot: GeometrySnapshot,
    *,
    owner_id: str | None,
) -> None:
    for root in snapshot.roots:
        _validate_alias(root.alias)
        _validate_coordinate(root.coordinate)
        _validate_sha256(root.moduleHash, "root moduleHash")
    aliases = [root.alias for root in snapshot.roots]
    if aliases != sorted(aliases):
        raise _bad(
            "Geometry roots must be sorted by alias.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if len(aliases) != len(set(aliases)):
        raise _bad(
            "Geometry root aliases must be unique.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    root_ids = [root.geometryVersionId for root in snapshot.roots]
    if len(root_ids) != len(set(root_ids)):
        raise _bad(
            "Geometry roots must reference unique Geometry versions.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    root_coordinates = [root.coordinate for root in snapshot.roots]
    if len(root_coordinates) != len(set(root_coordinates)):
        raise _bad(
            "Geometry root coordinates must be unique.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    coordinates = [module.coordinate for module in snapshot.modules]
    if coordinates != sorted(coordinates):
        raise _bad(
            "Geometry modules must be sorted by coordinate.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if len(coordinates) != len(set(coordinates)):
        raise _bad(
            "Geometry modules must be unique by coordinate.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    module_ids = [module.geometryVersionId for module in snapshot.modules]
    if len(module_ids) != len(set(module_ids)):
        raise _bad(
            "Geometry modules must be unique by geometryVersionId.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    total_source_bytes = 0
    for module in snapshot.modules:
        _validate_coordinate(module.coordinate)
        _validate_sha256(module.sourceHash, "sourceHash")
        _validate_sha256(module.moduleHash, "moduleHash")
        try:
            source_bytes = len(module.source.encode("utf-8"))
        except UnicodeEncodeError as error:
            raise _bad(
                "Geometry module source must contain valid UTF-8 text.",
                code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            ) from error
        if source_bytes > MAX_MODULE_SOURCE_BYTES:
            raise _bad(
                "Geometry module source exceeds 1 MiB.",
                code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        total_source_bytes += source_bytes
        for imported in module.imports:
            _validate_coordinate(imported.coordinate)
            _validate_sha256(imported.moduleHash, "import moduleHash")
        imported_coordinates = [item.coordinate for item in module.imports]
        if imported_coordinates != sorted(imported_coordinates):
            raise _bad(
                "Geometry module imports must be sorted by coordinate.",
                code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if len(imported_coordinates) != len(set(imported_coordinates)):
            raise _bad(
                "Geometry module imports must be unique by coordinate.",
                code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
    if total_source_bytes > MAX_GRAPH_SOURCE_BYTES:
        raise _bad(
            "Geometry graph source exceeds 8 MiB.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    expected = await build_snapshot(
        db,
        [(root.alias, root.geometryVersionId) for root in snapshot.roots],
        owner_id=owner_id,
    )
    if expected.model_dump(mode="json") != snapshot.model_dump(mode="json"):
        raise _bad("geometrySnapshot does not match the published Geometry graph.")
