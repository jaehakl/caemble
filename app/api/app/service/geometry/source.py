from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from fastapi import HTTPException, status
from tree_sitter import Language, Parser
import tree_sitter_typescript

from db import GeometryPackage, GeometryRepository, GeometryVersion


MAX_ENTRY_IMPORTS = 64
MAX_MODULES = 256
MAX_IMPORTS = 64
MAX_DEPTH = 64
MAX_MODULE_SOURCE_BYTES = 1024 * 1024
MAX_GRAPH_SOURCE_BYTES = 8 * 1024 * 1024
GEOMETRY_SEMVER_COMPONENT_MAX = 2_147_483_647
NAMESPACE_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$")
SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
SEMVER_RE = re.compile(r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$")
ALIAS_RE = re.compile(r"^[A-Z][A-Za-z0-9_]*$")
RESERVED_ALIASES = frozenset(
    "Array ArrayBuffer Atomics BigInt Blob Boolean DataView Date Document Element Error Event File "
    "FinalizationRegistry Float32Array Float64Array FormData Fragment Function Headers History Image "
    "Int16Array Int32Array Int8Array Intl JSON Location Map Math Node Number Object Promise Proxy Reflect "
    "RegExp Request Response Set SharedArrayBuffer SharedWorker String Symbol Uint16Array Uint32Array "
    "Uint8Array Uint8ClampedArray URL URLSearchParams WeakMap WeakRef WeakSet WebAssembly WebSocket Worker "
    "XMLHttpRequest".split()
)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COORDINATE_RE = re.compile(
    r"^caemble:geometry/"
    r"(?P<namespace>[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9]))/"
    r"(?P<repository>[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)/"
    r"(?P<package>[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)@"
    r"(?P<major>0|[1-9][0-9]*)\.(?P<minor>0|[1-9][0-9]*)\.(?P<patch>0|[1-9][0-9]*)$"
)
LOCAL_COORDINATE_RE = re.compile(
    r"^caemble:geometry/"
    r"(?P<namespace>[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9]))/"
    r"(?P<repository>[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)/"
    r"(?P<package>[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)@local$"
)
TSX_LANGUAGE = Language(tree_sitter_typescript.language_tsx())
SEMVER_COMPONENT_MAX_TEXT = str(GEOMETRY_SEMVER_COMPONENT_MAX)
GEOMETRY_SHARED_PROPS = frozenset(
    {"children", "id", "materials", "pos", "position", "rotate", "rotation", "scale"}
)


def _bad(message: str, *, code: int = status.HTTP_400_BAD_REQUEST) -> HTTPException:
    return HTTPException(status_code=code, detail=message)


def _validate_namespace(namespace: str) -> None:
    if NAMESPACE_RE.fullmatch(namespace) is None:
        raise _bad("Geometry namespace format is invalid.", code=status.HTTP_422_UNPROCESSABLE_ENTITY)


def _validate_slug(value: str, field_name: str) -> None:
    if SLUG_RE.fullmatch(value) is None:
        raise _bad(f"Geometry {field_name} format is invalid.", code=status.HTTP_422_UNPROCESSABLE_ENTITY)


def _validate_alias(alias: str) -> None:
    if ALIAS_RE.fullmatch(alias) is None or alias in RESERVED_ALIASES:
        raise _bad(
            "Geometry names and aliases must be non-reserved PascalCase identifiers.",
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
        raise _bad("Geometry coordinate format is invalid.", code=status.HTTP_422_UNPROCESSABLE_ENTITY)
    if not _coordinate_version_is_bounded(coordinate):
        raise _bad(
            f"Geometry version components must not exceed {GEOMETRY_SEMVER_COMPONENT_MAX}.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )


def source_hash(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def module_hash(
    coordinate: str,
    source_digest: str,
    imports: list[dict[str, str]],
    *,
    cad_api_version: int,
) -> str:
    canonical = json.dumps(
        {
            "schemaVersion": 2,
            "moduleFormatVersion": 4,
            "cadApiVersion": cad_api_version,
            "coordinate": coordinate,
            "sourceHash": source_digest,
            "imports": [
                {
                    "exportName": item["exportName"],
                    "alias": item["alias"],
                    "coordinate": item["coordinate"],
                    "moduleHash": item["moduleHash"],
                }
                for item in sorted(
                    imports,
                    key=lambda item: (item["alias"], item["exportName"], item["coordinate"]),
                )
            ],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _node_text(node: Any, encoded: bytes) -> str:
    return encoded[node.start_byte : node.end_byte].decode("utf-8")


def _geometry_type_props(
    node: Any,
    declarations: dict[str, Any],
    encoded: bytes,
    resolving: set[str] | None = None,
) -> list[str] | None:
    resolving = resolving or set()
    if node.type in {"object_type", "interface_body"}:
        names: list[str] = []
        for member in node.named_children:
            if member.type != "property_signature":
                return None
            name = next(
                (
                    child
                    for child in member.named_children
                    if child.type in {"property_identifier", "string"}
                ),
                None,
            )
            if name is None:
                return None
            names.append(_node_text(name, encoded).strip("\"'"))
        return names
    if node.type == "intersection_type":
        names: list[str] = []
        for item in node.named_children:
            resolved = _geometry_type_props(item, declarations, encoded, resolving)
            if resolved is None:
                return None
            names.extend(resolved)
        return list(dict.fromkeys(names))
    if node.type == "predefined_type" and _node_text(node, encoded) == "object":
        return []
    if node.type == "generic_type":
        type_name = next(
            (child for child in node.named_children if child.type == "type_identifier"),
            None,
        )
        arguments = next(
            (child for child in node.named_children if child.type == "type_arguments"),
            None,
        )
        if type_name is not None and _node_text(type_name, encoded) == "Readonly" and arguments is not None:
            parameter = next(iter(arguments.named_children), None)
            return (
                _geometry_type_props(parameter, declarations, encoded, resolving)
                if parameter is not None
                else None
            )
        return None
    if node.type not in {"type_identifier", "identifier"}:
        return None
    name = _node_text(node, encoded)
    if name in resolving or name not in declarations:
        return None
    declaration = declarations[name]
    body = declaration.child_by_field_name("body") or declaration.child_by_field_name("value")
    if body is None:
        return None
    return _geometry_type_props(body, declarations, encoded, resolving | {name})


def _component_custom_props(
    name: str,
    function: Any,
    annotation: Any | None,
    declarations: dict[str, Any],
    encoded: bytes,
) -> list[str]:
    if annotation is not None:
        generic = next(
            (child for child in annotation.named_children if child.type == "generic_type"),
            None,
        )
        if generic is not None:
            type_name = next(
                (child for child in generic.named_children if child.type == "type_identifier"),
                None,
            )
            arguments = next(
                (child for child in generic.named_children if child.type == "type_arguments"),
                None,
            )
            if type_name is not None and _node_text(type_name, encoded) == "Geometry":
                props_type = next(iter(arguments.named_children), None) if arguments is not None else None
                if props_type is None:
                    return []
                props = _geometry_type_props(props_type, declarations, encoded)
                if props is None:
                    raise _bad(
                        f"Geometry {name} props must use a statically enumerable inline or local object type."
                    )
                return props

    parameters = next(
        (child for child in function.named_children if child.type == "formal_parameters"),
        None,
    )
    parameter = next(iter(parameters.named_children), None) if parameters is not None else None
    if parameter is None:
        return []
    pattern = next(
        (child for child in parameter.named_children if child.type == "object_pattern"),
        None,
    )
    if pattern is None:
        raise _bad(f"Geometry {name} props must use direct object destructuring.")
    type_annotation = next(
        (child for child in parameter.named_children if child.type == "type_annotation"),
        None,
    )
    if type_annotation is not None:
        props_type = next(iter(type_annotation.named_children), None)
        props = (
            _geometry_type_props(props_type, declarations, encoded)
            if props_type is not None
            else None
        )
        if props is None:
            raise _bad(
                f"Geometry {name} props must use a statically enumerable inline or local object type."
            )
        return [prop for prop in props if prop not in GEOMETRY_SHARED_PROPS]
    return [
        _node_text(item.named_children[0], encoded)
        for item in pattern.named_children
        if item.type == "object_assignment_pattern"
        and item.named_children
        and _node_text(item.named_children[0], encoded) not in GEOMETRY_SHARED_PROPS
    ]


def _validate_geometry_component_defaults(
    name: str,
    function: Any,
    annotation: Any | None,
    declarations: dict[str, Any],
    encoded: bytes,
) -> None:
    custom_props = _component_custom_props(name, function, annotation, declarations, encoded)
    parameters = next(
        (child for child in function.named_children if child.type == "formal_parameters"),
        None,
    )
    parameter = next(iter(parameters.named_children), None) if parameters is not None else None
    if parameter is None:
        if custom_props:
            raise _bad(
                f"Geometry {name} must provide defaults for custom props: {', '.join(custom_props)}."
            )
        return
    pattern = next(
        (child for child in parameter.named_children if child.type == "object_pattern"),
        None,
    )
    if pattern is None:
        raise _bad(f"Geometry {name} props must use direct object destructuring.")
    defaults: set[str] = set()
    for item in pattern.named_children:
        if (
            item.type == "object_assignment_pattern"
            and item.named_children
            and item.named_children[0].type == "shorthand_property_identifier_pattern"
        ):
            prop = _node_text(item.named_children[0], encoded)
            if prop not in GEOMETRY_SHARED_PROPS:
                defaults.add(prop)
            continue
        prop = _node_text(item, encoded)
        if item.type == "shorthand_property_identifier_pattern" and prop in GEOMETRY_SHARED_PROPS:
            continue
        raise _bad(
            f"Geometry {name} props must use direct properties with explicit defaults."
        )
    missing = [prop for prop in custom_props if prop not in defaults]
    if missing:
        raise _bad(
            f"Geometry {name} must provide defaults for custom props: {', '.join(missing)}."
        )


def analyze_geometry_source(
    source: str,
    *,
    allow_empty: bool = False,
    allow_local: bool = False,
) -> dict[str, Any]:
    try:
        encoded = source.encode("utf-8")
    except UnicodeEncodeError as error:
        raise _bad(
            "Geometry module source must contain valid UTF-8 text.",
            code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        ) from error
    if len(encoded) > MAX_MODULE_SOURCE_BYTES:
        raise _bad("Geometry module source exceeds 1 MiB.")
    tree = Parser(TSX_LANGUAGE).parse(encoded)
    root = tree.root_node
    if root.has_error:
        error = next((node for node in _walk(root) if node.is_error or node.is_missing), root)
        row, column = error.start_point
        raise _bad(f"Geometry TSX syntax error at {row + 1}:{column + 1}.")

    bindings: dict[str, Any] = {}
    binding_annotations: dict[str, Any] = {}
    type_declarations: dict[str, Any] = {}
    imported_components: set[str] = set()
    imports: list[dict[str, Any]] = []
    export_specs: list[tuple[str, str]] = []

    for node in root.named_children:
        declaration = node.child_by_field_name("declaration") if node.type == "export_statement" else node
        if declaration is not None and declaration.type in {"type_alias_declaration", "interface_declaration"}:
            name_node = declaration.child_by_field_name("name") or next(
                (
                    child
                    for child in declaration.named_children
                    if child.type == "type_identifier"
                ),
                None,
            )
            if name_node is not None:
                type_declarations[_node_text(name_node, encoded)] = declaration
            continue
        if node.type == "import_statement":
            source_node = node.child_by_field_name("source")
            clause = next((child for child in node.named_children if child.type == "import_clause"), None)
            if source_node is None or source_node.type != "string" or clause is None:
                raise _bad("Geometry imports must use a static named import and string specifier.")
            raw = encoded[source_node.start_byte : source_node.end_byte]
            if len(raw) < 2 or raw[:1] not in {b"'", b'"'} or raw[-1:] != raw[:1]:
                raise _bad("Geometry imports must use a plain string specifier.")
            try:
                specifier = raw[1:-1].decode("utf-8")
            except UnicodeDecodeError as error:
                raise _bad("Geometry import specifier must be valid UTF-8.") from error
            named = clause.named_children
            if len(named) != 1 or named[0].type != "named_imports":
                raise _bad("Geometry imports must use named imports.")
            specifiers = [child for child in named[0].named_children if child.type == "import_specifier"]
            if specifier == "@caemble/core":
                if not specifiers:
                    raise _bad("Geometry imports from @caemble/core must name at least one binding.")
                import_is_type_only = any(child.type == "type" for child in node.children)
                for item in specifiers:
                    item_is_type_only = any(child.type == "type" for child in item.children)
                    names = [
                        encoded[child.start_byte : child.end_byte].decode("utf-8")
                        for child in item.named_children
                        if child.type == "identifier"
                    ]
                    if (
                        names
                        and names[0] == "Material"
                        and not import_is_type_only
                        and not item_is_type_only
                    ):
                        raise _bad(
                            "Material instances must be defined in material.tsx and imported from there."
                        )
                continue
            exact = COORDINATE_RE.fullmatch(specifier)
            local = LOCAL_COORDINATE_RE.fullmatch(specifier)
            if exact is None and (not allow_local or local is None):
                suffix = " or @local while editing" if allow_local else ""
                raise _bad(
                    f"Geometry imports must use an exact Geometry coordinate{suffix}.",
                    code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            if exact is not None and not _coordinate_version_is_bounded(specifier):
                raise _bad(
                    f"Geometry version components must not exceed {GEOMETRY_SEMVER_COMPONENT_MAX}.",
                    code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            if not specifiers:
                raise _bad("Geometry coordinate imports must import at least one named component.")
            for item in specifiers:
                if any(child.type == "type" for child in item.children):
                    raise _bad("Geometry coordinate imports must import runtime components, not types.")
                names = [
                    encoded[child.start_byte : child.end_byte].decode("utf-8")
                    for child in item.named_children
                    if child.type == "identifier"
                ]
                if not names:
                    raise _bad("Geometry coordinate import is malformed.")
                export_name = names[0]
                alias = names[-1]
                _validate_alias(export_name)
                _validate_alias(alias)
                if alias in imported_components or alias in bindings:
                    raise _bad(f"Geometry import alias is duplicated: {alias}")
                imported_components.add(alias)
                imports.append(
                    {
                        "exportName": export_name,
                        "alias": alias,
                        "coordinate": specifier,
                        "specifierStart": source_node.start_byte + 1,
                        "specifierEnd": source_node.end_byte - 1,
                    }
                )
            continue

        if declaration is not None and declaration.type == "lexical_declaration":
            if not any(child.type == "const" for child in declaration.children):
                if node.type == "export_statement":
                    raise _bad("Exported Geometry bindings must be const functions.")
                continue
            for declarator in (
                child for child in declaration.named_children if child.type == "variable_declarator"
            ):
                name_node = declarator.child_by_field_name("name")
                value = declarator.child_by_field_name("value")
                if name_node is not None and name_node.type == "identifier" and value is not None:
                    name = encoded[name_node.start_byte : name_node.end_byte].decode("utf-8")
                    bindings[name] = value
                    annotation = next(
                        (
                            child
                            for child in declarator.named_children
                            if child.type == "type_annotation"
                        ),
                        None,
                    )
                    if annotation is not None:
                        binding_annotations[name] = annotation
                    if node.type == "export_statement":
                        export_specs.append((name, name))
            continue
        if declaration is not None and declaration.type == "function_declaration":
            name_node = declaration.child_by_field_name("name")
            if name_node is not None:
                name = encoded[name_node.start_byte : name_node.end_byte].decode("utf-8")
                bindings[name] = declaration
                if node.type == "export_statement":
                    export_specs.append((name, name))
            continue
        if node.type != "export_statement":
            continue
        if any(child.type == "default" for child in node.children):
            raise _bad("Geometry modules do not support default exports.")
        if node.child_by_field_name("source") is not None:
            raise _bad("Geometry re-exports must use an imported local binding.")
        clause = next((child for child in node.named_children if child.type == "export_clause"), None)
        if clause is None:
            raise _bad("Geometry modules may only export named function components.")
        for item in (child for child in clause.named_children if child.type == "export_specifier"):
            names = [
                encoded[child.start_byte : child.end_byte].decode("utf-8")
                for child in item.named_children
                if child.type == "identifier"
            ]
            if not names:
                continue
            export_specs.append((names[0], names[-1]))

    aliases = [item["alias"] for item in imports]
    if len(aliases) != len(set(aliases)):
        raise _bad("Geometry import aliases must be unique within a module.")
    if len(imports) > MAX_IMPORTS:
        raise _bad(f"Geometry modules may import at most {MAX_IMPORTS} bindings.")

    for name in sorted(bindings):
        if ALIAS_RE.fullmatch(name) is None:
            continue
        function = _binding_function_node(name, bindings, encoded, set())
        if function is not None:
            _validate_geometry_component_defaults(
                name,
                function,
                binding_annotations.get(name),
                type_declarations,
                encoded,
            )

    exports: list[str] = []
    for local_name, export_name in export_specs:
        _validate_alias(export_name)
        if local_name not in imported_components and not _binding_is_function(
            local_name,
            bindings,
            encoded,
            set(),
        ):
            raise _bad(f"Geometry export must resolve to a function component: {export_name}")
        exports.append(export_name)
    if len(exports) != len(set(exports)):
        raise _bad("Geometry export names must be unique.")
    if not exports and not allow_empty:
        raise _bad("Published Geometry modules must export at least one named component.")

    _validate_runtime_policy(root, encoded)
    return {
        "exports": sorted(exports),
        "imports": sorted(
            imports,
            key=lambda item: (item["alias"], item["exportName"], item["coordinate"]),
        ),
    }


def rewrite_geometry_imports(source: str, replacements: dict[str, str]) -> str:
    analysis = analyze_geometry_source(source, allow_empty=True, allow_local=True)
    ranges = {
        (item["specifierStart"], item["specifierEnd"], item["coordinate"])
        for item in analysis["imports"]
        if item["coordinate"] in replacements
    }
    encoded = source.encode("utf-8")
    for start, end, coordinate in sorted(ranges, reverse=True):
        encoded = encoded[:start] + replacements[coordinate].encode("utf-8") + encoded[end:]
    return encoded.decode("utf-8")


def validate_experiment_tsx_imports(source: str, *, path: str) -> None:
    encoded = source.encode("utf-8")
    tree = Parser(TSX_LANGUAGE).parse(encoded)
    root = tree.root_node
    if root.has_error:
        error = next((node for node in _walk(root) if node.is_error or node.is_missing), root)
        row, column = error.start_point
        raise _bad(f"Experiment TSX syntax error at {row + 1}:{column + 1}.")
    if path == "material.tsx":
        allowed_imports = {"@caemble/core"}
    elif path == "experiment.tsx":
        allowed_imports = {"@caemble/core", "./geometry", "./material"}
    else:
        allowed_imports = {"@caemble/core", "../geometry", "../material"}
    for node in root.named_children:
        if node.type not in {"import_statement", "export_statement"}:
            continue
        source_node = node.child_by_field_name("source")
        if node.type == "export_statement":
            if source_node is None:
                continue
            raise _bad("Experiment sources do not support dependency re-exports.")
        clause = next(
            (child for child in node.named_children if child.type == "import_clause"),
            None,
        )
        if (
            source_node is None
            or source_node.type != "string"
            or (node.type == "import_statement" and clause is None)
        ):
            raise _bad("Experiment imports must use a static import clause and string specifier.")
        raw = encoded[source_node.start_byte : source_node.end_byte]
        if len(raw) < 2 or raw[:1] not in {b"'", b'"'} or raw[-1:] != raw[:1]:
            raise _bad("Experiment imports must use a plain string specifier.")
        specifier = raw[1:-1].decode("utf-8")
        if specifier not in allowed_imports:
            raise _bad(f"Experiment import is not allowed in {path}: {specifier}")
        named = clause.named_children
        if len(named) != 1 or named[0].type != "named_imports":
            raise _bad(f"Experiment imports must use named bindings in {path}: {specifier}")
        specifiers = [
            child for child in named[0].named_children if child.type == "import_specifier"
        ]
        if not specifiers:
            raise _bad(f"Experiment imports must name at least one binding in {path}: {specifier}")
        if specifier == "@caemble/core" and path != "material.tsx":
            import_is_type_only = any(child.type == "type" for child in node.children)
            for item in specifiers:
                item_is_type_only = any(child.type == "type" for child in item.children)
                names = [
                    encoded[child.start_byte : child.end_byte].decode("utf-8")
                    for child in item.named_children
                    if child.type == "identifier"
                ]
                if (
                    names
                    and names[0] == "Material"
                    and not import_is_type_only
                    and not item_is_type_only
                ):
                    raise _bad(
                        "Material instances must be defined in material.tsx and imported from there."
                    )
    for node in _walk(root):
        if node.type == "call_expression":
            function = node.child_by_field_name("function")
            if function is not None and encoded[function.start_byte : function.end_byte] in {
                b"import",
                b"require",
            }:
                raise _bad("Dynamic import and require() are not allowed in Experiment sources.")


def _binding_function_node(
    name: str,
    bindings: dict[str, Any],
    encoded: bytes,
    visiting: set[str],
) -> Any | None:
    if name in visiting:
        return None
    value = bindings.get(name)
    while value is not None and value.type in {
        "as_expression",
        "parenthesized_expression",
        "satisfies_expression",
        "type_assertion",
    }:
        value = next(iter(value.named_children), None)
    if value is None:
        return None
    if value.type in {"arrow_function", "function_declaration", "function_expression"}:
        return value
    if value.type != "identifier":
        return None
    target = encoded[value.start_byte : value.end_byte].decode("utf-8")
    return _binding_function_node(target, bindings, encoded, visiting | {name})


def _binding_is_function(
    name: str,
    bindings: dict[str, Any],
    encoded: bytes,
    visiting: set[str],
) -> bool:
    return _binding_function_node(name, bindings, encoded, visiting) is not None


def _validate_runtime_policy(root: Any, encoded: bytes) -> None:
    for node in _walk(root):
        if node.type == "call_expression":
            function = node.child_by_field_name("function")
            if function is None:
                continue
            name = encoded[function.start_byte : function.end_byte]
            if name in {b"import", b"require"}:
                raise _bad("Dynamic import and require() are not allowed in Geometry modules.")
            if name in {
                b"Date", b"Function", b"SharedWorker", b"WebSocket", b"Worker", b"XMLHttpRequest",
                b"clearInterval", b"clearTimeout", b"eval", b"fetch", b"queueMicrotask",
                b"setInterval", b"setTimeout",
            }:
                raise _bad(f"Hidden nondeterminism is not supported in Geometry modules: {name.decode()}.")
        elif node.type == "new_expression":
            constructor = node.child_by_field_name("constructor") or next(
                (child for child in node.named_children if child.type == "identifier"), None
            )
            if constructor is not None:
                name = encoded[constructor.start_byte : constructor.end_byte]
                if name in {b"Date", b"Function", b"WebSocket", b"Worker", b"SharedWorker", b"XMLHttpRequest"}:
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
                raise _bad(f"Hidden nondeterminism is not supported in Geometry modules: {object_name.decode()}.")
        elif node.type in {"identifier", "shorthand_property_identifier"}:
            name = encoded[node.start_byte : node.end_byte]
            if name in {
                b"Date", b"SharedWorker", b"WebSocket", b"Worker", b"XMLHttpRequest", b"crypto",
                b"global", b"globalThis", b"performance", b"process", b"self", b"window",
            }:
                raise _bad(f"Global runtime access is not supported in Geometry modules: {name.decode()}.")
        elif node.type == "variable_declarator":
            value_node = node.child_by_field_name("value")
            if value_node is not None and value_node.type == "identifier":
                name = encoded[value_node.start_byte : value_node.end_byte]
                if name == b"Math":
                    raise _bad("Aliasing Math is not supported in Geometry modules; call members directly.")


def _walk(node: Any):
    pending = [node]
    while pending:
        current = pending.pop()
        yield current
        pending.extend(reversed(current.named_children))


def _semver(version: GeometryVersion) -> str:
    return f"{version.version_major}.{version.version_minor}.{version.version_patch}"


def _coordinate(namespace: str, repository: str, package: str, version: str) -> str:
    return f"caemble:geometry/{namespace}/{repository}/{package}@{version}"


def _local_coordinate(namespace: str, repository: str, package: str) -> str:
    return f"caemble:geometry/{namespace}/{repository}/{package}@local"


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
    match = SEMVER_RE.fullmatch(value)
    if match is None:
        raise _bad("Geometry version must be a release-only SemVer value.")
    version = tuple(int(part) for part in value.split("."))
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
