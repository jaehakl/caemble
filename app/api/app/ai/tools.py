from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from caemble_catalog import CatalogNotFoundError
from fastapi import HTTPException

from ai.cad_reference import CAD_AUTHORING_ELEMENT_NAMES, cad_authoring_reference_details
from ai.data_tools import VisibleDataError, VisibleDataReader, VisibleResource
from ai.workspace import StagedExperiment, WorkspaceEditError
from service.geometry import build_snapshot_from_entry_source
from service.geometry.source import analyze_geometry_source


MAX_TOOL_OUTPUT_BYTES = 64 * 1024


@dataclass(frozen=True)
class ToolExecution:
    output: dict[str, Any]
    summary: str
    provenance: list[dict[str, Any]] = field(default_factory=list)

    def model_output(self) -> str:
        value = self.output if self.output.get("ok") is False else {"ok": True, "result": self.output}
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
        if len(encoded.encode("utf-8")) > MAX_TOOL_OUTPUT_BYTES:
            value = {
                "ok": False,
                "error": "Tool result exceeded 64 KiB; request a narrower search, source chunk, or data slice",
            }
            return json.dumps(value, separators=(",", ":"))
        return encoded


class ToolExecutor:
    def __init__(
        self,
        *,
        data: VisibleDataReader,
        catalog: Any,
        workspace: StagedExperiment,
    ):
        self.data = data
        self.catalog = catalog
        self.workspace = workspace
        self._source_reads: dict[tuple[str, str], list[tuple[int, int]]] = {}

    async def execute(self, name: str, arguments: dict[str, Any]) -> ToolExecution:
        try:
            return await self._execute(name, arguments)
        except (
            VisibleDataError,
            WorkspaceEditError,
            CatalogNotFoundError,
            KeyError,
            ValueError,
            HTTPException,
        ) as error:
            message = str(error.detail) if isinstance(error, HTTPException) else str(error)
            message = message or "Tool request is invalid"
            if len(message) > 1024:
                message = f"{message[:1021]}..."
            return ToolExecution({"ok": False, "error": message}, message)
        finally:
            await self.data.db.rollback()

    async def provenance_is_current(self, provenance: list[dict[str, Any]]) -> bool:
        if len(provenance) > 30:
            return False
        try:
            for item in provenance:
                kind = item.get("kind")
                revision = item.get("revision")
                if not isinstance(revision, str) or not revision:
                    return False
                if kind == "catalog":
                    if revision != self.catalog.meta()["catalogRevision"]:
                        return False
                    continue
                if kind == "database-search":
                    resource = item.get("resourceType")
                    query = item.get("query")
                    limit = item.get("limit")
                    if (
                        resource not in {
                            "material",
                            "experiment",
                            "measurement",
                            "recorded_data",
                            "geometry",
                            "designer_model",
                            "predictor_model",
                        }
                        or not isinstance(query, str)
                        or len(query) > 256
                        or isinstance(limit, bool)
                        or not isinstance(limit, int)
                        or not 1 <= limit <= 10
                    ):
                        return False
                    current_items = await self.data.search(resource, query, limit)
                    if _search_revision(current_items) != revision:
                        return False
                    continue
                if kind != "database":
                    return False
                resource = item.get("resourceType")
                resource_id = item.get("resourceId")
                if resource not in {
                    "material",
                    "experiment",
                    "measurement",
                    "recorded_data",
                    "geometry",
                    "designer_model",
                    "predictor_model",
                } or isinstance(resource_id, bool) or not isinstance(resource_id, int):
                    return False
                current = await self.data.detail(resource, resource_id)
                current_revision = (
                    current.get("evidenceRevision")
                    or current.get("sourceHash")
                    or current.get("updatedAt")
                    or current.get("updated_at")
                )
                if current_revision != revision:
                    return False
            return True
        except Exception:
            return False
        finally:
            await self.data.db.rollback()

    async def _execute(self, name: str, arguments: dict[str, Any]) -> ToolExecution:
        if name == "get_cad_authoring_reference":
            _exact_keys(arguments, {"elements"})
            value = cad_authoring_reference_details(arguments.get("elements"))
            return ToolExecution(
                value,
                f"Read official CAD authoring reference for {len(value['elements'])} elements",
            )
        if name == "search_catalog":
            _exact_keys(arguments, {"query", "limit"})
            query = _string(arguments, "query", maximum=256)
            limit = _integer(arguments, "limit", minimum=1, maximum=10)
            items = self.catalog.search(query, limit=limit)
            revision = self.catalog.meta()["catalogRevision"]
            provenance = [
                _catalog_provenance(
                    item.get("kind", "catalog"),
                    item.get("key", ""),
                    item.get("title", ""),
                    revision,
                )
                for item in items
                if isinstance(item, dict)
            ]
            return ToolExecution({"items": items}, f"Catalog search returned {len(items)} items", provenance)
        if name == "get_catalog_item":
            _exact_keys(arguments, {"kind", "key"})
            kind = _choice(arguments, "kind", {"quantityKind", "materialParameter", "materialModel", "solver"})
            key = _string(arguments, "key", maximum=256)
            value = _catalog_detail(self.catalog, kind, key)
            label = value.get("label_ko") or value.get("name") or key
            provenance = [
                _catalog_provenance(kind, key, str(label), self.catalog.meta()["catalogRevision"])
            ]
            return ToolExecution(value, f"Read catalog {kind} {key}", provenance)
        if name == "search_visible_data":
            _exact_keys(arguments, {"resource", "query", "limit"})
            resource = _resource(arguments)
            query = _string(arguments, "query", maximum=256)
            limit = _integer(arguments, "limit", minimum=1, maximum=10)
            items = await self.data.search(resource, query, limit)
            return ToolExecution(
                {"items": items},
                f"Visible {resource} search returned {len(items)} items",
                [_database_search_provenance(resource, query, limit, items)],
            )
        if name == "get_visible_data":
            _exact_keys(arguments, {"resource", "id"})
            resource = _resource(arguments)
            resource_id = _integer(arguments, "id", minimum=1)
            value = await self.data.detail(resource, resource_id)
            provenance = [_database_provenance(resource, value)]
            return ToolExecution(value, f"Read visible {resource} {resource_id}", provenance)
        if name == "read_visible_source":
            _exact_keys(arguments, {"resource", "id", "path", "offset", "length"})
            resource = _choice(arguments, "resource", {"experiment", "geometry"})
            value = await self.data.read_source(
                resource,
                _integer(arguments, "id", minimum=1),
                _nullable_string(arguments, "path", maximum=256),
                _integer(arguments, "offset", minimum=0),
                _integer(arguments, "length", minimum=1, maximum=24_000),
            )
            provenance = [value.pop("provenance")]
            return ToolExecution(value, f"Read {resource} source chunk", provenance)
        if name == "read_recorded_data_slice":
            _exact_keys(arguments, {"id", "offset", "count"})
            value = await self.data.read_recorded_slice(
                _integer(arguments, "id", minimum=1),
                _integer(arguments, "offset", minimum=0),
                _integer(arguments, "count", minimum=1, maximum=256),
            )
            provenance = [value.pop("provenance")]
            return ToolExecution(value, f"Read {len(value['values'])} RecordedData values", provenance)
        if name == "list_experiment_files":
            _exact_keys(arguments, set())
            return ToolExecution(self.workspace.manifest(), "Listed staged Experiment files")
        if name == "read_experiment_file":
            _exact_keys(arguments, {"path", "offset", "length"})
            path = _string(arguments, "path", maximum=256)
            offset = _integer(arguments, "offset", minimum=0)
            length = _integer(arguments, "length", minimum=1, maximum=24_000)
            while True:
                chunk = self.workspace.read_file(path, offset=offset, length=length)
                encoded = json.dumps(
                    {"ok": True, "result": chunk.as_dict()},
                    ensure_ascii=False,
                    separators=(",", ":"),
                    default=str,
                ).encode("utf-8")
                if len(encoded) <= MAX_TOOL_OUTPUT_BYTES:
                    break
                length = max(1, length // 2)
            self._source_reads.setdefault((chunk.path, chunk.sha256), []).append(
                (chunk.offset, chunk.offset + len(chunk.content))
            )
            return ToolExecution(chunk.as_dict(), f"Read staged {chunk.path}")
        if name == "write_experiment_file":
            _exact_keys(arguments, {"path", "content", "expectedSha256"})
            path = _string(arguments, "path", maximum=256)
            expected_sha256 = _nullable_hash(arguments, "expectedSha256")
            current = self.workspace.bundle.files.get(path)
            if current is not None and not self._was_fully_read(
                path,
                expected_sha256,
                len(current),
            ):
                raise WorkspaceEditError(
                    "Read the complete current source file before replacing it"
                )
            value = self.workspace.write_file(
                path,
                _string(arguments, "content", maximum=1024 * 1024),
                expected_sha256,
            )
            self._forget_source_reads(path)
            if path == "geometry.tsx":
                try:
                    await self._refresh_geometry_snapshot()
                except Exception:
                    pass
                else:
                    value["sourceHash"] = self.workspace.source_hash
            return ToolExecution(value, f"Staged {path}")
        if name == "delete_experiment_task":
            _exact_keys(arguments, {"path", "expectedSha256"})
            path = _string(arguments, "path", maximum=256)
            expected_sha256 = _hash(arguments, "expectedSha256")
            current = self.workspace.bundle.files.get(path)
            if current is None or not self._was_fully_read(path, expected_sha256, len(current)):
                raise WorkspaceEditError(
                    "Read the complete current Task source before deleting it"
                )
            value = self.workspace.delete_task(path, expected_sha256)
            self._forget_source_reads(path)
            return ToolExecution(value, f"Deleted staged {path}")
        raise ValueError("Agent tool is not supported")

    async def _refresh_geometry_snapshot(self) -> None:
        source = self.workspace.bundle.files["geometry.tsx"]
        analysis = analyze_geometry_source(source, allow_empty=True, allow_local=True)
        if any(str(item.get("coordinate", "")).endswith("@local") for item in analysis["imports"]):
            return
        snapshot = await build_snapshot_from_entry_source(
            self.data.db,
            source,
            owner_id=self.data.user_id,
        )
        self.workspace.replace_geometry_snapshot(snapshot)

    def _was_fully_read(self, path: str, source_hash: str | None, total: int) -> bool:
        if source_hash is None:
            return False
        covered = 0
        for start, end in sorted(self._source_reads.get((path, source_hash), [])):
            if start > covered:
                return False
            covered = max(covered, end)
            if covered >= total:
                return True
        return total == 0 and bool(self._source_reads.get((path, source_hash)))

    def _forget_source_reads(self, path: str) -> None:
        for key in [key for key in self._source_reads if key[0] == path]:
            del self._source_reads[key]


def agent_tool_definitions() -> list[dict[str, Any]]:
    return [
        _tool(
            "get_cad_authoring_reference",
            "Read the server-bundled official CAD API v8 authoring contracts for primitives and operations before creating or editing geometry.tsx.",
            {
                "elements": {
                    "type": "array",
                    "items": {"type": "string", "enum": list(CAD_AUTHORING_ELEMENT_NAMES)},
                    "minItems": 1,
                    "maxItems": 14,
                }
            },
        ),
        _tool(
            "search_catalog",
            "Search the Caemble QuantityKind, MaterialParameter, MaterialModel, and Solver catalog.",
            {"query": _string_schema(256), "limit": _integer_schema(1, 10)},
        ),
        _tool(
            "get_catalog_item",
            "Read one full catalog item and its relations.",
            {
                "kind": {"type": "string", "enum": ["quantityKind", "materialParameter", "materialModel", "solver"]},
                "key": _string_schema(256),
            },
        ),
        _tool(
            "search_visible_data",
            "Search public and user-owned visible records. Geometry, Measurement, and RecordedData are user-owned only.",
            {
                "resource": {
                    "type": "string",
                    "enum": [
                        "material",
                        "experiment",
                        "measurement",
                        "recorded_data",
                        "geometry",
                        "designer_model",
                        "predictor_model",
                    ],
                },
                "query": _string_schema(256),
                "limit": _integer_schema(1, 10),
            },
        ),
        _tool(
            "get_visible_data",
            "Read metadata for one visible database record without external files or full source.",
            {
                "resource": {
                    "type": "string",
                    "enum": [
                        "material",
                        "experiment",
                        "measurement",
                        "recorded_data",
                        "geometry",
                        "designer_model",
                        "predictor_model",
                    ],
                },
                "id": _integer_schema(1),
            },
        ),
        _tool(
            "read_visible_source",
            "Read a bounded source chunk from a visible Experiment or user-owned Geometry.",
            {
                "resource": {"type": "string", "enum": ["experiment", "geometry"]},
                "id": _integer_schema(1),
                "path": {"type": ["string", "null"], "maxLength": 256},
                "offset": _integer_schema(0),
                "length": _integer_schema(1, 24_000),
            },
        ),
        _tool(
            "read_recorded_data_slice",
            "Read at most 256 flattened values from user-owned RecordedData stored in the database.",
            {
                "id": _integer_schema(1),
                "offset": _integer_schema(0),
                "count": _integer_schema(1, 256),
            },
        ),
        _tool("list_experiment_files", "List staged Experiment files and hashes.", {}),
        _tool(
            "read_experiment_file",
            "Read a bounded chunk of a staged Experiment source file before editing it.",
            {
                "path": _string_schema(256),
                "offset": _integer_schema(0),
                "length": _integer_schema(1, 24_000),
            },
        ),
        _tool(
            "write_experiment_file",
            "Replace one staged source file using its last observed SHA-256, or null only for a new Task file.",
            {
                "path": _string_schema(256),
                "content": _string_schema(1024 * 1024),
                "expectedSha256": {
                    "type": ["string", "null"],
                    "pattern": "^[0-9a-f]{64}$",
                },
            },
        ),
        _tool(
            "delete_experiment_task",
            "Delete one staged tasks/<name>.tsx file using its last observed SHA-256.",
            {
                "path": _string_schema(256),
                "expectedSha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
            },
        ),
    ]


def _tool(name: str, description: str, properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "function",
        "name": name,
        "description": description,
        "strict": True,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": list(properties),
            "additionalProperties": False,
        },
    }


def _catalog_detail(catalog: Any, kind: str, key: str) -> dict[str, Any]:
    if kind == "quantityKind":
        return {**catalog.quantity_kind(key), "relations": catalog.quantity_kind_relations(key)}
    if kind == "materialParameter":
        return {**catalog.material_parameter(key), "relations": catalog.material_parameter_relations(key)}
    if kind == "materialModel":
        return catalog.material_model(key)
    if "@" not in key:
        raise ValueError("Solver key must use name@version")
    name, version = key.rsplit("@", 1)
    return catalog.solver_detail(name, version)


def _exact_keys(arguments: dict[str, Any], expected: set[str]) -> None:
    if set(arguments) != expected:
        raise ValueError("Tool arguments do not match the strict schema")


def _string(arguments: dict[str, Any], key: str, *, maximum: int) -> str:
    value = arguments.get(key)
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError(f"{key} must be a string of at most {maximum} characters")
    return value


def _nullable_string(arguments: dict[str, Any], key: str, *, maximum: int) -> str | None:
    value = arguments.get(key)
    if value is None:
        return None
    return _string(arguments, key, maximum=maximum)


def _integer(
    arguments: dict[str, Any],
    key: str,
    *,
    minimum: int,
    maximum: int | None = None,
) -> int:
    value = arguments.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"{key} must be an integer greater than or equal to {minimum}")
    if maximum is not None and value > maximum:
        raise ValueError(f"{key} must be at most {maximum}")
    return value


def _choice(arguments: dict[str, Any], key: str, choices: set[str]) -> str:
    value = arguments.get(key)
    if not isinstance(value, str) or value not in choices:
        raise ValueError(f"{key} is not supported")
    return value


def _resource(arguments: dict[str, Any]) -> VisibleResource:
    return _choice(
        arguments,
        "resource",
        {
            "material",
            "experiment",
            "measurement",
            "recorded_data",
            "geometry",
            "designer_model",
            "predictor_model",
        },
    )  # type: ignore[return-value]


def _hash(arguments: dict[str, Any], key: str) -> str:
    value = _string(arguments, key, maximum=64)
    if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
        raise ValueError(f"{key} must be a lowercase SHA-256")
    return value


def _nullable_hash(arguments: dict[str, Any], key: str) -> str | None:
    return None if arguments.get(key) is None else _hash(arguments, key)


def _string_schema(maximum: int) -> dict[str, Any]:
    return {"type": "string", "maxLength": maximum}


def _integer_schema(minimum: int, maximum: int | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {"type": "integer", "minimum": minimum}
    if maximum is not None:
        value["maximum"] = maximum
    return value


def _catalog_provenance(kind: str, key: str, label: str, revision: str) -> dict[str, Any]:
    return {
        "kind": "catalog",
        "label": label or key,
        "resourceType": kind,
        "resourceId": key,
        "revision": revision,
    }


def _database_provenance(resource: str, value: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "database",
        "label": str(value.get("name") or f"{resource} {value.get('id')}"),
        "resourceType": resource,
        "resourceId": value.get("id"),
        "revision": (
            value.get("evidenceRevision")
            or value.get("sourceHash")
            or value.get("updatedAt")
            or value.get("updated_at")
        ),
    }


def _database_search_provenance(
    resource: str,
    query: str,
    limit: int,
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "kind": "database-search",
        "label": f"{resource} search",
        "resourceType": resource,
        "resourceId": query,
        "query": query,
        "limit": limit,
        "revision": _search_revision(items),
    }


def _search_revision(items: list[dict[str, Any]]) -> str:
    encoded = json.dumps(
        items,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
