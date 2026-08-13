from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from fastapi import HTTPException, status
from tree_sitter import Language, Parser
import tree_sitter_typescript

from db import GeometryPackage, GeometryRepository, GeometryVersion


MAX_ROOTS = 64
MAX_MODULES = 256
MAX_IMPORTS = 64
MAX_DEPTH = 64
MAX_MODULE_SOURCE_BYTES = 1024 * 1024
MAX_GRAPH_SOURCE_BYTES = 8 * 1024 * 1024
GEOMETRY_SEMVER_COMPONENT_MAX = 2_147_483_647
NAMESPACE_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$")
SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
SEMVER_RE = re.compile(r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$")
ALIAS_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COORDINATE_RE = re.compile(
    r"^caemble:geometry/"
    r"(?P<namespace>[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9]))/"
    r"(?P<repository>[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)/"
    r"(?P<package>[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)@"
    r"(?P<major>0|[1-9][0-9]*)\.(?P<minor>0|[1-9][0-9]*)\.(?P<patch>0|[1-9][0-9]*)$"
)
TSX_LANGUAGE = Language(tree_sitter_typescript.language_tsx())
SEMVER_COMPONENT_MAX_TEXT = str(GEOMETRY_SEMVER_COMPONENT_MAX)


def _bad(message: str, *, code: int = status.HTTP_400_BAD_REQUEST) -> HTTPException:
    return HTTPException(status_code=code, detail=message)


def _validate_namespace(namespace: str) -> None:
    if NAMESPACE_RE.fullmatch(namespace) is None:
        raise _bad(
            "Geometry namespace format is invalid.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )


def _validate_slug(value: str, field_name: str) -> None:
    if SLUG_RE.fullmatch(value) is None:
        raise _bad(
            f"Geometry {field_name} format is invalid.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )


def _validate_alias(alias: str) -> None:
    if ALIAS_RE.fullmatch(alias) is None:
        raise _bad(
            "Geometry root alias format is invalid.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )


def _validate_sha256(value: str, field_name: str) -> None:
    if SHA256_RE.fullmatch(value) is None:
        raise _bad(
            f"Geometry {field_name} must be a lowercase SHA-256 hash.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )


def _validate_coordinate(coordinate: str) -> None:
    if COORDINATE_RE.fullmatch(coordinate) is None:
        raise _bad(
            "Geometry coordinate format is invalid.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if not _coordinate_version_is_bounded(coordinate):
        raise _bad(
            f"Geometry version components must not exceed {GEOMETRY_SEMVER_COMPONENT_MAX}.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )


def source_hash(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def module_hash(coordinate: str, source_digest: str, imports: list[dict[str, str]]) -> str:
    canonical = json.dumps(
        {
            "schemaVersion": 1,
            "moduleFormatVersion": 1,
            "cadApiVersion": 5,
            "coordinate": coordinate,
            "sourceHash": source_digest,
            "imports": sorted(imports, key=lambda item: item["coordinate"]),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def analyze_geometry_source(source: str) -> list[tuple[str, int, int]]:
    encoded = source.encode("utf-8")
    if len(encoded) > MAX_MODULE_SOURCE_BYTES:
        raise _bad("Geometry module source exceeds 1 MiB.")
    tree = Parser(TSX_LANGUAGE).parse(encoded)
    root = tree.root_node
    if root.has_error:
        error = next((node for node in _walk(root) if node.is_error or node.is_missing), root)
        row, column = error.start_point
        raise _bad(f"Geometry TSX syntax error at {row + 1}:{column + 1}.")

    imports: list[tuple[str, int, int]] = []
    default_exports = 0
    for node in root.named_children:
        if node.type == "import_statement":
            source_node = node.child_by_field_name("source")
            clause = next((child for child in node.named_children if child.type == "import_clause"), None)
            if source_node is None or source_node.type != "string" or clause is None:
                raise _bad("Geometry imports must use a static import clause and string specifier.")
            raw = encoded[source_node.start_byte : source_node.end_byte]
            if len(raw) < 2 or raw[:1] not in {b"'", b'"'} or raw[-1:] != raw[:1]:
                raise _bad("Geometry imports must use a plain string specifier.")
            try:
                specifier = raw[1:-1].decode("utf-8")
            except UnicodeDecodeError as error:
                raise _bad("Geometry import specifier must be valid UTF-8.") from error
            named = clause.named_children
            if specifier == "@caemble/core":
                if len(named) != 1 or named[0].type != "named_imports":
                    raise _bad("@caemble/core must use named or type imports in Geometry modules.")
                continue
            if COORDINATE_RE.fullmatch(specifier) is None:
                raise _bad(
                    f"Geometry import must use an exact same-owner coordinate: {specifier}",
                    code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            if not _coordinate_version_is_bounded(specifier):
                raise _bad(
                    f"Geometry version components must not exceed {GEOMETRY_SEMVER_COMPONENT_MAX}.",
                    code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            if len(named) != 1 or named[0].type != "identifier":
                raise _bad("Geometry dependencies must use one default import.")
            if any(child.type == "type" for child in node.children):
                raise _bad("Geometry dependencies cannot be type-only imports.")
            imports.append((specifier, source_node.start_byte + 1, source_node.end_byte - 1))
        elif node.type == "export_statement":
            if any(child.type == "default" for child in node.children):
                default_exports += 1
                declaration = next(
                    (
                        child
                        for child in node.named_children
                        if child.type not in {"identifier"} or encoded[child.start_byte : child.end_byte] != b"default"
                    ),
                    None,
                )
                if declaration is not None and declaration.type in {
                    "function_declaration",
                    "class_declaration",
                    "abstract_class_declaration",
                }:
                    raise _bad("Geometry default export must be a Geometry-compatible value.")
            else:
                raise _bad("Geometry modules may only export one default value.")

    for node in _walk(root):
        if node.type == "call_expression":
            function = node.child_by_field_name("function")
            if function is not None:
                name = encoded[function.start_byte : function.end_byte]
                if name in {b"import", b"require"}:
                    raise _bad("Dynamic import and require() are not allowed in Geometry modules.")
                if name in {
                    b"Date",
                    b"Function",
                    b"SharedWorker",
                    b"WebSocket",
                    b"Worker",
                    b"XMLHttpRequest",
                    b"clearInterval",
                    b"clearTimeout",
                    b"eval",
                    b"fetch",
                    b"queueMicrotask",
                    b"setInterval",
                    b"setTimeout",
                }:
                    raise _bad(f"Hidden nondeterminism is not supported in Geometry modules: {name.decode()}.")
        elif node.type == "new_expression":
            constructor = node.child_by_field_name("constructor") or next(
                (child for child in node.named_children if child.type == "identifier"),
                None,
            )
            if constructor is not None:
                name = encoded[constructor.start_byte : constructor.end_byte]
                if name in {
                    b"Date",
                    b"Function",
                    b"WebSocket",
                    b"Worker",
                    b"SharedWorker",
                    b"XMLHttpRequest",
                }:
                    raise _bad(f"Hidden nondeterminism is not supported in Geometry modules: {name.decode()}.")
        elif node.type in {"member_expression", "subscript_expression"}:
            object_node = node.child_by_field_name("object")
            property_node = node.child_by_field_name("property") or node.child_by_field_name("index")
            if object_node is None or property_node is None:
                continue
            object_name = encoded[object_node.start_byte : object_node.end_byte]
            property_name = encoded[property_node.start_byte : property_node.end_byte]
            if property_node.type == "string":
                property_name = property_name[1:-1]
            if property_name in {b"__proto__", b"constructor", b"prototype"}:
                raise _bad(f"Prototype access is not supported in Geometry modules: {property_name.decode()}.")
            if object_name == b"Math" and property_name == b"random":
                raise _bad("Hidden nondeterminism is not supported in Geometry modules: Math.random.")
            if object_name in {b"Date", b"crypto", b"performance"}:
                raise _bad(
                    f"Hidden nondeterminism is not supported in Geometry modules: {object_name.decode()}."
                )
        elif node.type in {"identifier", "shorthand_property_identifier"}:
            name = encoded[node.start_byte : node.end_byte]
            if name in {
                b"Date",
                b"SharedWorker",
                b"WebSocket",
                b"Worker",
                b"XMLHttpRequest",
                b"crypto",
                b"global",
                b"globalThis",
                b"performance",
                b"process",
                b"self",
                b"window",
            }:
                raise _bad(f"Global runtime access is not supported in Geometry modules: {name.decode()}.")
        elif node.type == "variable_declarator":
            value_node = node.child_by_field_name("value")
            if value_node is not None and value_node.type == "identifier":
                name = encoded[value_node.start_byte : value_node.end_byte]
                if name == b"Math":
                    raise _bad(
                        "Aliasing Math is not supported in Geometry modules; "
                        "call deterministic Math members directly."
                    )
    if default_exports != 1:
        raise _bad("Geometry modules must contain exactly one direct default export.")
    coordinates = [item[0] for item in imports]
    if len(coordinates) > MAX_IMPORTS:
        raise _bad(f"Geometry modules may import at most {MAX_IMPORTS} Geometry modules.")
    if len(coordinates) != len(set(coordinates)):
        raise _bad("Geometry dependency coordinates must be unique within a module.")
    return imports


def validate_experiment_tsx_imports(source: str, *, allow_geometry_registry: bool) -> None:
    encoded = source.encode("utf-8")
    tree = Parser(TSX_LANGUAGE).parse(encoded)
    root = tree.root_node
    if root.has_error:
        error = next((node for node in _walk(root) if node.is_error or node.is_missing), root)
        row, column = error.start_point
        raise _bad(f"Experiment TSX syntax error at {row + 1}:{column + 1}.")
    for node in root.named_children:
        if node.type != "import_statement":
            continue
        source_node = node.child_by_field_name("source")
        clause = next((child for child in node.named_children if child.type == "import_clause"), None)
        if source_node is None or source_node.type != "string" or clause is None:
            raise _bad("Experiment imports must use a static import clause and string specifier.")
        raw = encoded[source_node.start_byte : source_node.end_byte]
        if len(raw) < 2 or raw[:1] not in {b"'", b'"'} or raw[-1:] != raw[:1]:
            raise _bad("Experiment imports must use a plain string specifier.")
        specifier = raw[1:-1].decode("utf-8")
        if specifier == "@caemble/core":
            continue
        if specifier == "@caemble/geometries" and allow_geometry_registry:
            named = clause.named_children
            if len(named) != 1 or named[0].type != "identifier":
                raise _bad("@caemble/geometries must use one default import.")
            continue
        raise _bad(f"Experiment import is not allowed: {specifier}")
    for node in _walk(root):
        if node.type == "call_expression":
            function = node.child_by_field_name("function")
            if function is not None and encoded[function.start_byte : function.end_byte] in {
                b"import",
                b"require",
            }:
                raise _bad("Dynamic import and require() are not allowed in Experiment sources.")


def _walk(node):
    pending = [node]
    while pending:
        current = pending.pop()
        yield current
        pending.extend(reversed(current.named_children))


def _semver(version: GeometryVersion) -> str:
    return f"{version.version_major}.{version.version_minor}.{version.version_patch}"


def _coordinate(namespace: str, repository: str, package: str, version: str) -> str:
    return f"caemble:geometry/{namespace}/{repository}/{package}@{version}"


def _row_coordinate(row: tuple[GeometryVersion, GeometryPackage, GeometryRepository, str]) -> str:
    version, package, repository, namespace = row
    return _coordinate(namespace, repository.slug, package.name, _semver(version))


def _bump(version: tuple[int, int, int], kind: str) -> tuple[int, int, int]:
    major, minor, patch = version
    if kind == "major":
        bumped = major + 1, 0, 0
    elif kind == "minor":
        bumped = major, minor + 1, 0
    else:
        bumped = major, minor, patch + 1
    if any(component > GEOMETRY_SEMVER_COMPONENT_MAX for component in bumped):
        raise _bad(f"Geometry version components must not exceed {GEOMETRY_SEMVER_COMPONENT_MAX}.")
    return bumped


def _version_tuple(value: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value)
    if match is None:
        raise _bad("Geometry version must be a release-only SemVer value.")
    version = tuple(int(part) for part in match.groups())
    if any(component > GEOMETRY_SEMVER_COMPONENT_MAX for component in version):
        raise _bad(f"Geometry version components must not exceed {GEOMETRY_SEMVER_COMPONENT_MAX}.")
    return version


def _semver_component_is_bounded(value: str) -> bool:
    return len(value) < len(SEMVER_COMPONENT_MAX_TEXT) or (
        len(value) == len(SEMVER_COMPONENT_MAX_TEXT) and value <= SEMVER_COMPONENT_MAX_TEXT
    )


def _coordinate_version_is_bounded(coordinate: str) -> bool:
    match = COORDINATE_RE.fullmatch(coordinate)
    return match is not None and all(
        _semver_component_is_bounded(match.group(component))
        for component in ("major", "minor", "patch")
    )
