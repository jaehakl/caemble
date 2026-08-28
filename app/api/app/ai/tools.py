from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, cast

from caemble_catalog import CatalogError
from fastapi import HTTPException

from ai.cad_reference import cad_authoring_reference_details
from ai.calculation_reference import calculation_authoring_reference_details
from ai.data_tools import VisibleDataError, VisibleDataReader, VisibleResource
from ai.workspace import StagedCalculation, StagedExperiment, WorkspaceEditError


@dataclass(frozen=True)
class ToolExecution:
    output: dict[str, Any]
    summary: str
    provenance: list[dict[str, Any]] = field(default_factory=list)

    def model_output(self) -> str:
        value = self.output if self.output.get("ok") is False else {"ok": True, "result": self.output}
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


class ToolExecutor:
    def __init__(
        self,
        *,
        data: VisibleDataReader,
        catalog: Any,
        workspace: StagedExperiment | StagedCalculation,
    ):
        self.data = data
        self.catalog = catalog
        self.workspace = workspace

    async def execute(self, name: str, arguments: dict[str, Any]) -> ToolExecution:
        try:
            return await self._execute(name, arguments)
        except (
            VisibleDataError,
            WorkspaceEditError,
            CatalogError,
            KeyError,
            ValueError,
            HTTPException,
        ) as error:
            message = str(error.detail) if isinstance(error, HTTPException) else str(error)
            message = message or "Tool request is invalid"
            return ToolExecution({"ok": False, "error": message}, message)
        finally:
            await self.data.db.rollback()

    async def _execute(self, name: str, arguments: dict[str, Any]) -> ToolExecution:
        if name == "get_cad_authoring_reference":
            value = cad_authoring_reference_details(arguments["elements"])
            return ToolExecution(
                value,
                f"Read official CAD authoring reference for {len(value['elements'])} elements",
            )
        if name == "get_calculation_authoring_reference":
            value = calculation_authoring_reference_details(arguments["sections"])
            return ToolExecution(value, "Read Calculation authoring reference")
        if name == "search_catalog":
            query = arguments["query"]
            limit = arguments["limit"]
            items = self.catalog.search(query, limit=limit)
            provenance = [
                _catalog_provenance(
                    item.get("kind", "catalog"),
                    item.get("key", ""),
                    item.get("title", ""),
                )
                for item in items
                if isinstance(item, dict)
            ]
            return ToolExecution({"items": items}, f"Catalog search returned {len(items)} items", provenance)
        if name == "get_catalog_item":
            kind = arguments["kind"]
            key = arguments["key"]
            value = _catalog_detail(self.catalog, kind, key)
            label = value.get("label_ko") or value.get("name") or key
            provenance = [
                _catalog_provenance(kind, key, str(label))
            ]
            return ToolExecution(value, f"Read catalog {kind} {key}", provenance)
        if name == "search_visible_data":
            resource = cast(VisibleResource, arguments["resource"])
            query = arguments["query"]
            limit = arguments["limit"]
            items = await self.data.search(resource, query, limit)
            return ToolExecution(
                {"items": items},
                f"Visible {resource} search returned {len(items)} items",
                [_database_search_provenance(resource, query, limit)],
            )
        if name == "get_visible_data":
            resource = cast(VisibleResource, arguments["resource"])
            resource_id = arguments["id"]
            value = await self.data.detail(resource, resource_id)
            provenance = [_database_provenance(resource, value)]
            return ToolExecution(value, f"Read visible {resource} {resource_id}", provenance)
        if name == "read_visible_source":
            resource = arguments["resource"]
            value = await self.data.read_source(
                resource,
                arguments["id"],
                arguments.get("path"),
                arguments["offset"],
                arguments["length"],
            )
            provenance = [value.pop("provenance")]
            return ToolExecution(value, f"Read {resource} source chunk", provenance)
        if name == "read_recorded_data_slice":
            value = await self.data.read_recorded_slice(
                arguments["id"],
                arguments["offset"],
                arguments["count"],
            )
            provenance = [value.pop("provenance")]
            return ToolExecution(value, f"Read {len(value['values'])} RecordedData values", provenance)
        if name == "list_experiment_files":
            experiment = (
                self.workspace.reference_experiment
                if isinstance(self.workspace, StagedCalculation)
                else self.workspace
            )
            return ToolExecution(experiment.manifest(), "Listed staged Experiment files")
        if name == "read_experiment_file":
            path = arguments["path"]
            offset = arguments["offset"]
            length = arguments["length"]
            experiment = (
                self.workspace.reference_experiment
                if isinstance(self.workspace, StagedCalculation)
                else self.workspace
            )
            chunk = experiment.read_file(path, offset=offset, length=length)
            return ToolExecution(chunk.as_dict(), f"Read staged {chunk.path}")
        if name == "write_experiment_file":
            if isinstance(self.workspace, StagedCalculation):
                raise WorkspaceEditError("Experiment source is read-only in a Calculation run")
            path = arguments["path"]
            expected_sha256 = arguments.get("expectedSha256")
            value = self.workspace.write_file(
                path,
                arguments["content"],
                expected_sha256,
            )
            return ToolExecution(value, f"Staged {path}")
        if name == "delete_experiment_file":
            if isinstance(self.workspace, StagedCalculation):
                raise WorkspaceEditError("Experiment source is read-only in a Calculation run")
            path = arguments["path"]
            expected_sha256 = arguments["expectedSha256"]
            value = self.workspace.delete_file(path, expected_sha256)
            return ToolExecution(value, f"Deleted staged {path}")
        if name == "read_calculation_source":
            if not isinstance(self.workspace, StagedCalculation):
                raise WorkspaceEditError("Calculation source is unavailable")
            chunk = self.workspace.read_source(offset=arguments["offset"], length=arguments["length"])
            return ToolExecution(chunk.as_dict(), "Read staged Calculation source")
        if name == "write_calculation_source":
            if not isinstance(self.workspace, StagedCalculation):
                raise WorkspaceEditError("Calculation source is unavailable")
            value = self.workspace.write_source(arguments["content"], arguments["expectedSha256"])
            return ToolExecution(value, "Staged Calculation source")
        raise ValueError("Agent tool is not supported")


def agent_tool_definitions(
    workspace: StagedExperiment | StagedCalculation,
) -> list[dict[str, Any]]:
    common = [
        _tool(
            "get_cad_authoring_reference",
            "Read the server-bundled official CAD authoring contracts for primitives and operations before creating or editing geometry.tsx.",
            {
                "elements": {
                    "type": "array",
                    "items": {"type": "string"},
                }
            },
        ),
        _tool(
            "search_catalog",
            "Search the Caemble QuantityKind, MaterialParameter, MaterialModel, Solver, and Experiment catalog.",
            {"query": _string_schema(), "limit": _integer_schema()},
        ),
        _tool(
            "get_catalog_item",
            "Read one full catalog item and its relations. Use the full coordinate returned by search_catalog for an Experiment.",
            {
                "kind": {
                    "type": "string",
                },
                "key": _string_schema(),
            },
        ),
        _tool(
            "search_visible_data",
            "Search public and user-owned visible records. Measurement and RecordedData are user-owned only.",
            {
                "resource": {
                    "type": "string",
                },
                "query": _string_schema(),
                "limit": _integer_schema(),
            },
        ),
        _tool(
            "get_visible_data",
            "Read metadata for one visible database record without external files or full source.",
            {
                "resource": {
                    "type": "string",
                },
                "id": _integer_schema(),
            },
        ),
        _tool(
            "read_visible_source",
            "Read a source chunk from a visible Experiment or Calculation.",
            {
                "resource": {"type": "string"},
                "id": _integer_schema(),
                "path": {"type": ["string", "null"]},
                "offset": _integer_schema(),
                "length": _integer_schema(),
            },
        ),
        _tool(
            "read_recorded_data_slice",
            "Read flattened values from user-owned RecordedData stored in the database.",
            {
                "id": _integer_schema(),
                "offset": _integer_schema(),
                "count": _integer_schema(),
            },
        ),
        _tool("list_experiment_files", "List staged Experiment files and hashes.", {}),
        _tool(
            "read_experiment_file",
            "Read a chunk of the current Experiment source. It is read-only in a Calculation run.",
            {
                "path": _string_schema(),
                "offset": _integer_schema(),
                "length": _integer_schema(),
            },
        ),
    ]
    if isinstance(workspace, StagedCalculation):
        tools = [
            *common,
            _tool(
                "get_calculation_authoring_reference",
                "Read generated Calculation contract, limits, Math.js API, Monaco declaration, or skeleton.",
                {"sections": {"type": "array", "items": {"type": "string"}}},
            ),
            _tool(
                "read_calculation_source",
                "Read a Calculation source chunk and its SHA-256 before editing.",
                {"offset": _integer_schema(), "length": _integer_schema()},
            ),
        ]
        if workspace.editable:
            tools.append(
                _tool(
                    "write_calculation_source",
                    "Replace the complete staged Calculation source using its last observed SHA-256.",
                    {"content": _string_schema(), "expectedSha256": {"type": "string"}},
                )
            )
        return tools
    return [
        *common,
        _tool(
            "write_experiment_file",
            "Replace one staged source file using its last observed SHA-256, or null for a new TS/TSX file.",
            {
                "path": _string_schema(),
                "content": _string_schema(),
                "expectedSha256": {"type": ["string", "null"]},
            },
        ),
        _tool(
            "delete_experiment_file",
            "Delete one staged non-core TS/TSX file using its last observed SHA-256.",
            {
                "path": _string_schema(),
                "expectedSha256": {"type": "string"},
            },
        ),
    ]


def _tool(name: str, description: str, properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "function",
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
        },
    }


def _catalog_detail(catalog: Any, kind: str, key: str) -> dict[str, Any]:
    if kind == "quantityKind":
        return {**catalog.quantity_kind(key), "relations": catalog.quantity_kind_relations(key)}
    if kind == "materialParameter":
        return {**catalog.material_parameter(key), "relations": catalog.material_parameter_relations(key)}
    if kind == "materialModel":
        return catalog.material_model(key)
    if kind == "experiment":
        return catalog.experiment(key)
    name, version = key.rsplit("@", 1)
    return catalog.solver_detail(name, version)


def _string_schema() -> dict[str, Any]:
    return {"type": "string"}


def _integer_schema() -> dict[str, Any]:
    return {"type": "integer"}


def _catalog_provenance(kind: str, key: str, label: str) -> dict[str, Any]:
    return {
        "kind": "catalog",
        "label": label or key,
        "resourceType": kind,
        "resourceId": key,
    }


def _database_provenance(resource: str, value: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "database",
        "label": str(value.get("name") or f"{resource} {value.get('id')}"),
        "resourceType": resource,
        "resourceId": value.get("id"),
    }


def _database_search_provenance(
    resource: str,
    query: str,
    limit: int,
) -> dict[str, Any]:
    return {
        "kind": "database-search",
        "label": f"{resource} search",
        "resourceType": resource,
        "resourceId": query,
        "query": query,
        "limit": limit,
    }
