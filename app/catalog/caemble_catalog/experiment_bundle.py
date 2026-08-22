from __future__ import annotations

import posixpath
import re
from collections.abc import Iterable, Mapping
from typing import Any

import tree_sitter_typescript
from tree_sitter import Language, Parser


SOURCE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$")
TS_LANGUAGE = Language(tree_sitter_typescript.language_typescript())
TSX_LANGUAGE = Language(tree_sitter_typescript.language_tsx())


class ExperimentBundleError(ValueError):
    """An official Experiment bundle violates the executable module policy."""


def _walk(node: Any) -> Iterable[Any]:
    pending = [node]
    while pending:
        current = pending.pop()
        yield current
        pending.extend(reversed(current.named_children))


def is_experiment_source_path(path: str) -> bool:
    return (
        bool(path)
        and len(path) <= 256
        and "\\" not in path
        and not path.startswith("/")
        and posixpath.normpath(path) == path
        and not path.startswith("../")
        and not path.endswith(".d.ts")
        and all(
            segment not in {"", ".", ".."} and SOURCE_SEGMENT_RE.fullmatch(segment) is not None
            for segment in path.split("/")
        )
        and (path == "simulate.py" or path.endswith((".ts", ".tsx")))
    )


def _quoted_specifier(node: Any, encoded: bytes, path: str) -> str:
    if node is None or node.type != "string":
        raise ExperimentBundleError(f"Imports and re-exports in {path} require a string specifier")
    raw = encoded[node.start_byte : node.end_byte]
    if len(raw) < 2 or raw[:1] not in {b"'", b'"'} or raw[-1:] != raw[:1]:
        raise ExperimentBundleError(f"Imports and re-exports in {path} require a plain string specifier")
    try:
        return raw[1:-1].decode("utf-8")
    except UnicodeDecodeError as error:
        raise ExperimentBundleError(f"Import specifier in {path} must be valid UTF-8") from error


def _relative_target(path: str, specifier: str, available: set[str]) -> str:
    if not specifier.startswith(("./", "../")) or "\\" in specifier:
        raise ExperimentBundleError(f"Bundle imports must be relative or use @caemble/core: {specifier}")
    if any(
        segment not in {"", ".", ".."} and SOURCE_SEGMENT_RE.fullmatch(segment) is None
        for segment in specifier.split("/")
    ):
        raise ExperimentBundleError(f"Bundle import path is invalid in {path}: {specifier}")
    joined = posixpath.normpath(posixpath.join(posixpath.dirname(path), specifier))
    if joined == ".." or joined.startswith("../") or joined.startswith("/"):
        raise ExperimentBundleError(f"Bundle import escapes the source bundle in {path}: {specifier}")
    explicit_typescript_path = not joined.endswith(".d.ts") and joined.endswith((".ts", ".tsx"))
    candidates = (
        [joined]
        if explicit_typescript_path
        else [f"{joined}.ts", f"{joined}.tsx", f"{joined}/index.ts", f"{joined}/index.tsx"]
    )
    resolved = [candidate for candidate in candidates if candidate in available]
    if len(resolved) != 1:
        qualifier = "ambiguous" if resolved else "not found"
        raise ExperimentBundleError(f"Bundle import is {qualifier} in {path}: {specifier}")
    return resolved[0]


def _is_type_only(node: Any) -> bool:
    if any(child.type == "type" for child in node.children):
        return True
    specifiers = [item for item in _walk(node) if item.type in {"import_specifier", "export_specifier"}]
    return bool(specifiers) and all(
        any(child.type == "type" for child in item.children) for item in specifiers
    )


def validate_experiment_module_graph(files: Mapping[str, str]) -> None:
    module_paths = {path for path in files if path.endswith((".ts", ".tsx"))}
    runtime_edges: dict[str, set[str]] = {path: set() for path in module_paths}
    for path in sorted(module_paths):
        encoded = files[path].encode("utf-8")
        is_tsx = path.endswith(".tsx")
        root = Parser(TSX_LANGUAGE if is_tsx else TS_LANGUAGE).parse(encoded).root_node
        if root.has_error:
            error = next((item for item in _walk(root) if item.is_error or item.is_missing), root)
            row, column = error.start_point
            source_kind = "TSX" if is_tsx else "TypeScript"
            raise ExperimentBundleError(
                f"Experiment {source_kind} syntax error in {path} at {row + 1}:{column + 1}"
            )
        for node in root.named_children:
            if node.type not in {"import_statement", "export_statement"}:
                continue
            statement = encoded[node.start_byte : node.end_byte].lstrip()
            if any(item.type == "import_require_clause" for item in _walk(node)) or statement.startswith(
                b"export ="
            ):
                raise ExperimentBundleError(
                    f"TypeScript import-equals and export-assignment syntax is not supported in {path}"
                )
            source_node = node.child_by_field_name("source")
            if source_node is None:
                continue
            specifier = _quoted_specifier(source_node, encoded, path)
            if specifier == "@caemble/core":
                if node.type == "import_statement":
                    clause = next(
                        (child for child in node.named_children if child.type == "import_clause"),
                        None,
                    )
                    bindings = clause.named_children if clause is not None else []
                    named = bindings[0] if len(bindings) == 1 else None
                    if (
                        named is None
                        or named.type != "named_imports"
                        or not any(child.type == "import_specifier" for child in named.named_children)
                    ):
                        raise ExperimentBundleError(
                            f"@caemble/core imports must use named bindings in {path}"
                        )
                continue
            target = _relative_target(path, specifier, module_paths)
            if not _is_type_only(node):
                runtime_edges[path].add(target)
        for node in _walk(root):
            if node.type != "call_expression":
                continue
            function = node.child_by_field_name("function")
            if function is not None and encoded[function.start_byte : function.end_byte] in {
                b"import",
                b"require",
            }:
                raise ExperimentBundleError(f"Dynamic import and require() are not allowed in {path}")

    states = {path: "pending" for path in runtime_edges}
    for start in sorted(runtime_edges):
        if states[start] == "complete":
            continue
        states[start] = "visiting"
        pending = [(start, iter(sorted(runtime_edges[start])))]
        while pending:
            path, targets = pending[-1]
            try:
                target = next(targets)
            except StopIteration:
                states[path] = "complete"
                pending.pop()
                continue
            if states[target] == "visiting":
                raise ExperimentBundleError(f"Runtime bundle import cycle detected at {target}")
            if states[target] == "complete":
                continue
            states[target] = "visiting"
            pending.append((target, iter(sorted(runtime_edges[target]))))
