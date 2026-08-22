from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterator, Sequence

from .errors import CatalogAmbiguousError, CatalogIntegrityError, CatalogNotFoundError
from .schema import (
    APPLICATION_ID,
    EXPERIMENT_COORDINATE_PREFIX,
    RUNTIME_SLICE_SCHEMA_VERSION,
    SCHEMA_VERSION,
    parse_experiment_coordinate,
    parse_experiment_version,
)


def catalog_path() -> Path:
    return Path(__file__).with_name("catalog.sqlite3")


def _json(value: str | None) -> Any:
    return None if value is None else json.loads(value)


class Catalog:
    """Read-only access to the versioned CAE catalog snapshot."""

    def __init__(self, connection: sqlite3.Connection, path: Path):
        self._connection = connection
        self.path = path
        self._lock = threading.RLock()

    @classmethod
    def open_readonly(cls, path: Path | str | None = None, *, immutable: bool = True) -> "Catalog":
        resolved = Path(path) if path is not None else catalog_path()
        resolved = resolved.resolve()
        if not resolved.is_file():
            raise CatalogNotFoundError(f"Catalog SQLite file does not exist: {resolved}")
        query = "mode=ro"
        if immutable:
            query += "&immutable=1"
        connection = sqlite3.connect(
            f"{resolved.as_uri()}?{query}",
            uri=True,
            check_same_thread=False,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        instance = cls(connection, resolved)
        try:
            instance.validate()
        except BaseException:
            connection.close()
            raise
        return instance

    def __enter__(self) -> "Catalog":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def _all(self, sql: str, parameters: Sequence[object] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._connection.execute(sql, parameters).fetchall()

    def _one(self, sql: str, parameters: Sequence[object] = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._connection.execute(sql, parameters).fetchone()

    def validate(self) -> None:
        application_id = self._one("PRAGMA application_id")[0]
        user_version = self._one("PRAGMA user_version")[0]
        if application_id != APPLICATION_ID or user_version != SCHEMA_VERSION:
            raise CatalogIntegrityError(
                f"Unsupported catalog identity/schema: application_id={application_id}, user_version={user_version}"
            )
        quick_check = self._one("PRAGMA quick_check")[0]
        if quick_check != "ok":
            raise CatalogIntegrityError(f"Catalog quick_check failed: {quick_check}")
        foreign_keys = self._all("PRAGMA foreign_key_check")
        if foreign_keys:
            raise CatalogIntegrityError(f"Catalog contains {len(foreign_keys)} foreign-key violation(s)")
        required = {"catalogRevision", "quantityKindDataVersion", "materialCatalogVersion"}
        present = {row["key"] for row in self._all("SELECT key FROM catalog_metadata")}
        if missing := required - present:
            raise CatalogIntegrityError(f"Catalog metadata is missing: {', '.join(sorted(missing))}")

    def meta(self) -> dict[str, Any]:
        metadata = {row["key"]: row["value"] for row in self._all("SELECT key, value FROM catalog_metadata")}
        counts = self._one(
            """
            SELECT
              (SELECT count(*) FROM quantity_kinds) AS quantity_kind_count,
              (SELECT count(*) FROM material_parameters) AS material_parameter_count,
              (SELECT count(*) FROM material_models) AS material_model_count,
              (SELECT count(*) FROM solvers) AS solver_count,
              (SELECT count(*) FROM experiments) AS experiment_count
            """
        )
        global_qualifiers = [
            row["qualifier"] for row in self._all("SELECT qualifier FROM material_global_qualifiers ORDER BY ordinal")
        ]
        design_rules = {
            row["key"]: row["description"]
            for row in self._all("SELECT key, description FROM material_design_rules ORDER BY key")
        }
        return {
            "schemaVersion": SCHEMA_VERSION,
            "catalogRevision": metadata["catalogRevision"],
            "quantityKindDataVersion": metadata["quantityKindDataVersion"],
            "materialCatalogVersion": metadata["materialCatalogVersion"],
            "quantityKindCount": counts["quantity_kind_count"],
            "materialParameterCount": counts["material_parameter_count"],
            "materialModelCount": counts["material_model_count"],
            "solverCount": counts["solver_count"],
            "experimentCount": counts["experiment_count"],
            "materialGlobalQualifiers": global_qualifiers,
            "materialDesignRules": design_rules,
        }

    def quantity_kind(self, name: str) -> dict[str, Any]:
        row = self._one(
            "SELECT name, domain, tensor_order, description, opaque FROM quantity_kinds WHERE name = ?",
            (name,),
        )
        if row is None:
            raise CatalogNotFoundError(f"Unknown QuantityKind: {name}")
        units = self._all(
            "SELECT unit FROM quantity_kind_units WHERE quantity_kind = ? ORDER BY ordinal",
            (name,),
        )
        return {
            "name": row["name"],
            "domain": row["domain"],
            "tensorOrder": row["tensor_order"],
            "description": row["description"],
            "opaque": bool(row["opaque"]),
            "applicableUnits": [unit["unit"] for unit in units],
        }

    get_quantity_kind = quantity_kind

    def list_quantity_kinds(
        self,
        *,
        query: str | None = None,
        domain: str | None = None,
        solver_name: str | None = None,
        solver_version: str | None = None,
        usage: str | None = None,
        unit: str | None = None,
        tensor_order: int | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        joins = ""
        clauses: list[str] = []
        parameters: list[object] = []
        if solver_name is not None or usage is not None:
            joins += " JOIN solver_quantity_kind_usages u ON u.quantity_kind = q.name"
        if solver_name is not None:
            clauses.append("u.solver_name = ?")
            parameters.append(solver_name)
            if solver_version is not None:
                clauses.append("u.solver_version = ?")
                parameters.append(solver_version)
        if usage is not None:
            clauses.append("u.context = ?")
            parameters.append(usage)
        if unit is not None:
            joins += " JOIN quantity_kind_units qu ON qu.quantity_kind = q.name"
            clauses.append("qu.unit = ?")
            parameters.append(unit)
        if query:
            clauses.append("(q.name LIKE ? ESCAPE '\\' OR coalesce(q.description, '') LIKE ? ESCAPE '\\')")
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            parameters.extend((f"%{escaped}%", f"%{escaped}%"))
        if domain:
            clauses.append("q.domain = ?")
            parameters.append(domain)
        if tensor_order is not None:
            clauses.append("q.tensor_order = ?")
            parameters.append(tensor_order)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        total = self._one(f"SELECT count(DISTINCT q.name) AS value FROM quantity_kinds q{joins}{where}", parameters)[
            "value"
        ]
        rows = self._all(
            f"SELECT DISTINCT q.name FROM quantity_kinds q{joins}{where} ORDER BY q.name LIMIT ? OFFSET ?",
            (*parameters, limit, offset),
        )
        return [self.quantity_kind(row["name"]) for row in rows], total

    def quantity_kind_relations(self, name: str) -> dict[str, Any]:
        self.quantity_kind(name)
        materials = self._all(
            "SELECT key, label_ko FROM material_parameters WHERE quantity_kind = ? ORDER BY key",
            (name,),
        )
        usages = self._all(
            """
            SELECT solver_name, solver_version, context, path, unit
            FROM quantity_kind_solver_usages WHERE quantity_kind = ?
            ORDER BY solver_name, solver_version, context, path
            """,
            (name,),
        )
        return {
            "materialParameters": [{"key": row["key"], "labelKo": row["label_ko"]} for row in materials],
            "solverUsages": [
                {
                    "solverName": row["solver_name"],
                    "solverVersion": row["solver_version"],
                    "context": row["context"],
                    "path": row["path"],
                    "unit": row["unit"],
                }
                for row in usages
            ],
        }

    def material_parameter(self, key: str) -> dict[str, Any]:
        row = self._one(
            "SELECT key, domain, label_ko, quantity_kind FROM material_parameters WHERE key = ?",
            (key,),
        )
        if row is None:
            raise CatalogNotFoundError(f"Unknown Material parameter: {key}")
        qualifiers = self._all(
            "SELECT qualifier FROM material_parameter_qualifiers WHERE material_parameter = ? ORDER BY ordinal",
            (key,),
        )
        return {
            "key": row["key"],
            "domain": row["domain"],
            "labelKo": row["label_ko"],
            "quantityKind": row["quantity_kind"],
            "specialQualifiers": [item["qualifier"] for item in qualifiers],
        }

    def list_material_parameters(
        self,
        *,
        query: str | None = None,
        domain: str | None = None,
        solver_name: str | None = None,
        solver_version: str | None = None,
        quantity_kind: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        joins = ""
        clauses: list[str] = []
        parameters: list[object] = []
        if solver_name is not None:
            joins = " JOIN solver_material_properties p ON p.material_parameter = m.key"
            clauses.append("p.solver_name = ?")
            parameters.append(solver_name)
            if solver_version is not None:
                clauses.append("p.solver_version = ?")
                parameters.append(solver_version)
        if query:
            clauses.append("(m.key LIKE ? ESCAPE '\\' OR m.label_ko LIKE ? ESCAPE '\\')")
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            parameters.extend((f"%{escaped}%", f"%{escaped}%"))
        if domain:
            clauses.append("m.domain = ?")
            parameters.append(domain)
        if quantity_kind:
            clauses.append("m.quantity_kind = ?")
            parameters.append(quantity_kind)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        total = self._one(f"SELECT count(DISTINCT m.key) AS value FROM material_parameters m{joins}{where}", parameters)[
            "value"
        ]
        rows = self._all(
            f"SELECT DISTINCT m.key FROM material_parameters m{joins}{where} ORDER BY m.key LIMIT ? OFFSET ?",
            (*parameters, limit, offset),
        )
        return [self.material_parameter(row["key"]) for row in rows], total

    def material_parameter_relations(self, key: str) -> dict[str, Any]:
        material = self.material_parameter(key)
        requirements = self._all(
            """
            SELECT solver_name, solver_version, role, target_category, target_method_id, description
            FROM solver_material_requirements WHERE material_parameter = ?
            ORDER BY solver_name, solver_version, role
            """,
            (key,),
        )
        return {
            "quantityKindDefinition": self.quantity_kind(material["quantityKind"]),
            "solverRequirements": [
                {
                    "solverName": row["solver_name"],
                    "solverVersion": row["solver_version"],
                    "role": row["role"],
                    "methodCategory": row["target_category"],
                    "methodId": row["target_method_id"],
                    "description": row["description"],
                }
                for row in requirements
            ],
        }

    def material_model(self, key: str) -> dict[str, Any]:
        row = self._one("SELECT * FROM material_models WHERE key = ?", (key,))
        if row is None:
            raise CatalogNotFoundError(f"Unknown Material model: {key}")
        return {
            "key": row["key"],
            "labelKo": row["label_ko"],
            "kind": row["kind"],
            "input": {"name": row["input_name"], "quantityKind": row["input_quantity_kind"]},
            "output": {"name": row["output_name"], "quantityKind": row["output_quantity_kind"]},
            "minimumSamples": row["minimum_samples"],
            "sharedBasis": bool(row["shared_basis"]),
        }

    def material_models(self) -> list[dict[str, Any]]:
        return [self.material_model(row["key"]) for row in self._all("SELECT key FROM material_models ORDER BY key")]

    def list_material_models(
        self, *, query: str | None = None, limit: int = 50, offset: int = 0
    ) -> tuple[list[dict[str, Any]], int]:
        if query:
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            like = f"%{escaped}%"
            total = self._one(
                "SELECT count(*) AS value FROM material_models WHERE key LIKE ? ESCAPE '\\' OR label_ko LIKE ? ESCAPE '\\'",
                (like, like),
            )["value"]
            rows = self._all(
                """
                SELECT key FROM material_models WHERE key LIKE ? ESCAPE '\\' OR label_ko LIKE ? ESCAPE '\\'
                ORDER BY key LIMIT ? OFFSET ?
                """,
                (like, like, limit, offset),
            )
        else:
            total = self._one("SELECT count(*) AS value FROM material_models")["value"]
            rows = self._all("SELECT key FROM material_models ORDER BY key LIMIT ? OFFSET ?", (limit, offset))
        return [self.material_model(row["key"]) for row in rows], total

    def solver_contracts(self) -> dict[tuple[str, str], str]:
        return {
            (row["name"], row["version"]): row["contract_digest"]
            for row in self._all("SELECT name, version, contract_digest FROM solvers ORDER BY name, version")
        }

    def solver_contract_digest(self, name: str, version: str) -> str:
        row = self._one("SELECT contract_digest FROM solvers WHERE name = ? AND version = ?", (name, version))
        if row is None:
            raise CatalogNotFoundError(f"Unknown Solver: {name}@{version}")
        return row["contract_digest"]

    get_solver_contract_digest = solver_contract_digest

    def _named_data(self, table: str, name: str, version: str) -> dict[str, Any]:
        rows = self._all(
            f"SELECT name, description, data_json FROM {table} WHERE solver_name = ? AND solver_version = ? ORDER BY ordinal",
            (name, version),
        )
        return {row["name"]: {"description": row["description"], "data": _json(row["data_json"])} for row in rows}

    def get_solver_manifest(self, name: str, version: str) -> dict[str, Any]:
        solver = self._one("SELECT * FROM solvers WHERE name = ? AND version = ?", (name, version))
        if solver is None:
            raise CatalogNotFoundError(f"Unknown Solver: {name}@{version}")
        descriptor: dict[str, Any] = {
            "name": solver["name"],
            "version": solver["version"],
            "description": solver["description"],
            "referenceLengthUnit": solver["reference_length_unit"],
            "minimumOutputs": solver["minimum_outputs"],
            "parameters": self._named_data("solver_parameters", name, version),
        }
        roles = self._all(
            "SELECT * FROM solver_material_roles WHERE solver_name = ? AND solver_version = ? ORDER BY ordinal",
            (name, version),
        )
        descriptor["materials"] = []
        for role in roles:
            properties = self._all(
                """
                SELECT material_parameter, description, data_json FROM solver_material_properties
                WHERE solver_name = ? AND solver_version = ? AND role = ? ORDER BY ordinal
                """,
                (name, version, role["role"]),
            )
            descriptor["materials"].append(
                {
                    "role": role["role"],
                    "description": role["description"],
                    "target": {"category": role["target_category"], "methodId": role["target_method_id"]},
                    "properties": {
                        item["material_parameter"]: {
                            "description": item["description"],
                            "data": _json(item["data_json"]),
                        }
                        for item in properties
                    },
                }
            )
        descriptor["inputPorts"] = {}
        for port in self._all(
            "SELECT * FROM solver_input_ports WHERE solver_name = ? AND solver_version = ? ORDER BY ordinal",
            (name, version),
        ):
            artifacts = self._all(
                """
                SELECT artifact_type FROM solver_input_artifact_types
                WHERE solver_name = ? AND solver_version = ? AND input_port = ? ORDER BY ordinal
                """,
                (name, version, port["name"]),
            )
            descriptor["inputPorts"][port["name"]] = {
                "description": port["description"],
                "artifactTypes": [item["artifact_type"] for item in artifacts],
                "minimumOccurrences": port["minimum_occurrences"],
                "maximumOccurrences": port["maximum_occurrences"],
                "data": _json(port["data_json"]),
            }
        descriptor["observations"] = {
            row["name"]: {"description": row["description"], "type": row["type"]}
            for row in self._all(
                "SELECT * FROM solver_observations WHERE solver_name = ? AND solver_version = ? ORDER BY ordinal",
                (name, version),
            )
        }
        descriptor["methods"] = {"initializations": [], "boundaryConditions": [], "outputs": []}
        for method in self._all(
            """
            SELECT * FROM solver_methods WHERE solver_name = ? AND solver_version = ?
            ORDER BY CASE category WHEN 'initializations' THEN 0 WHEN 'boundaryConditions' THEN 1 ELSE 2 END, ordinal
            """,
            (name, version),
        ):
            parameters = self._all(
                """
                SELECT name, description, data_json FROM solver_method_parameters
                WHERE solver_name = ? AND solver_version = ? AND category = ? AND method_id = ? ORDER BY ordinal
                """,
                (name, version, method["category"], method["method_id"]),
            )
            item: dict[str, Any] = {
                "methodId": method["method_id"],
                "description": method["description"],
                "minimumOccurrences": method["minimum_occurrences"],
                "maximumOccurrences": method["maximum_occurrences"],
                "target": {
                    "source": method["target_source"],
                    "kind": method["target_kind"],
                    "minimumTargets": method["minimum_targets"],
                    "maximumTargets": method["maximum_targets"],
                    "minimumResolved": method["minimum_resolved"],
                    "maximumResolved": method["maximum_resolved"],
                },
                "parameters": {
                    parameter["name"]: {
                        "description": parameter["description"],
                        "data": _json(parameter["data_json"]),
                    }
                    for parameter in parameters
                },
            }
            if method["artifact_type"] is not None:
                item["artifactType"] = method["artifact_type"]
            if method["data_json"] is not None:
                item["data"] = _json(method["data_json"])
            descriptor["methods"][method["category"]].append(item)
        return {
            "schemaVersion": solver["schema_version"],
            "implementation": solver["implementation"],
            "descriptor": descriptor,
        }

    def solver_manifests(self) -> list[dict[str, Any]]:
        return [
            self.get_solver_manifest(row["name"], row["version"])
            for row in self._all("SELECT name, version FROM solvers ORDER BY name, version")
        ]

    def solver_summary(self, name: str, version: str) -> dict[str, Any]:
        manifest = self.get_solver_manifest(name, version)
        descriptor = manifest["descriptor"]
        return {
            "name": name,
            "version": version,
            "description": descriptor["description"],
            "contractDigest": self.solver_contract_digest(name, version),
        }

    def list_solvers(self, *, query: str | None = None) -> list[dict[str, Any]]:
        if query:
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            rows = self._all(
                "SELECT name, version FROM solvers WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' ORDER BY name",
                (f"%{escaped}%", f"%{escaped}%"),
            )
        else:
            rows = self._all("SELECT name, version FROM solvers ORDER BY name")
        return [self.solver_summary(row["name"], row["version"]) for row in rows]

    def page_solvers(
        self, *, query: str | None = None, limit: int = 50, offset: int = 0
    ) -> tuple[list[dict[str, Any]], int]:
        items = self.list_solvers(query=query)
        return items[offset : offset + limit], len(items)

    def solver_detail(self, name: str, version: str) -> dict[str, Any]:
        summary = self.solver_summary(name, version)
        manifest = self.get_solver_manifest(name, version)
        requirements = self._all(
            "SELECT * FROM solver_material_requirements WHERE solver_name = ? AND solver_version = ? ORDER BY role, material_parameter",
            (name, version),
        )
        usages = self._all(
            "SELECT * FROM solver_quantity_kind_usages WHERE solver_name = ? AND solver_version = ? ORDER BY ordinal",
            (name, version),
        )
        produced = self._all(
            """
            SELECT method_id, artifact_type FROM solver_methods
            WHERE solver_name = ? AND solver_version = ? AND artifact_type IS NOT NULL ORDER BY ordinal
            """,
            (name, version),
        )
        consumed = self._all(
            """
            SELECT a.input_port, a.artifact_type FROM solver_input_artifact_types a
            JOIN solver_input_ports p ON p.solver_name = a.solver_name AND p.solver_version = a.solver_version AND p.name = a.input_port
            WHERE a.solver_name = ? AND a.solver_version = ? ORDER BY p.ordinal, a.ordinal
            """,
            (name, version),
        )
        produced_items = []
        for row in produced:
            consumers = self._all(
                """
                SELECT consumer_solver_name, consumer_solver_version, consumer_input_port
                FROM solver_artifact_compatibility
                WHERE producer_solver_name = ? AND producer_solver_version = ? AND producer_method_id = ?
                ORDER BY consumer_solver_name, consumer_solver_version, consumer_input_port
                """,
                (name, version, row["method_id"]),
            )
            produced_items.append(
                {
                    "methodId": row["method_id"],
                    "artifactType": row["artifact_type"],
                    "consumers": [
                        {
                            "solverName": item["consumer_solver_name"],
                            "solverVersion": item["consumer_solver_version"],
                            "inputPort": item["consumer_input_port"],
                        }
                        for item in consumers
                    ],
                }
            )
        consumed_items = []
        for row in consumed:
            producers = self._all(
                """
                SELECT producer_solver_name, producer_solver_version, producer_method_id
                FROM solver_artifact_compatibility
                WHERE consumer_solver_name = ? AND consumer_solver_version = ? AND consumer_input_port = ?
                ORDER BY producer_solver_name, producer_solver_version, producer_method_id
                """,
                (name, version, row["input_port"]),
            )
            consumed_items.append(
                {
                    "inputPort": row["input_port"],
                    "artifactType": row["artifact_type"],
                    "producers": [
                        {
                            "solverName": item["producer_solver_name"],
                            "solverVersion": item["producer_solver_version"],
                            "methodId": item["producer_method_id"],
                        }
                        for item in producers
                    ],
                }
            )
        return {
            **summary,
            "descriptor": manifest["descriptor"],
            "materialRequirements": [
                {
                    "solverName": row["solver_name"],
                    "solverVersion": row["solver_version"],
                    "role": row["role"],
                    "roleDescription": row["role_description"],
                    "methodCategory": row["target_category"],
                    "methodId": row["target_method_id"],
                    "materialParameter": row["material_parameter"],
                    "description": row["description"],
                    "quantityKind": row["quantity_kind"],
                    "unit": row["unit"],
                }
                for row in requirements
            ],
            "quantityKindUsages": [
                {
                    "solverName": row["solver_name"],
                    "solverVersion": row["solver_version"],
                    "quantityKind": row["quantity_kind"],
                    "context": row["context"],
                    "path": row["path"],
                    "unit": row["unit"],
                }
                for row in usages
            ],
            "producesArtifacts": produced_items,
            "consumesArtifacts": consumed_items,
        }

    def experiment(
        self,
        key: str,
        *,
        namespace: str | None = None,
        repository: str | None = None,
        version: str | None = None,
        include_bundle: bool = True,
    ) -> dict[str, Any]:
        identifier = key
        if key.startswith(EXPERIMENT_COORDINATE_PREFIX):
            try:
                coordinate_namespace, coordinate_repository, coordinate_key, coordinate_version = (
                    parse_experiment_coordinate(key)
                )
            except ValueError as error:
                raise CatalogNotFoundError(f"Invalid Experiment coordinate: {key}: {error}") from error
            if (
                (namespace is not None and namespace != coordinate_namespace)
                or (repository is not None and repository != coordinate_repository)
                or (version is not None and version != coordinate_version)
            ):
                raise CatalogNotFoundError(f"Conflicting Experiment coordinate selector: {key}")
            namespace = coordinate_namespace
            repository = coordinate_repository
            key = coordinate_key
            version = coordinate_version

        clauses = ["key = ?"]
        parameters: list[object] = [key]
        if namespace is not None:
            clauses.append("namespace = ?")
            parameters.append(namespace)
        if repository is not None:
            clauses.append("repository_slug = ?")
            parameters.append(repository)
        if version is not None:
            try:
                parts = parse_experiment_version(version)
            except ValueError as error:
                raise CatalogNotFoundError(str(error)) from error
            clauses.extend(("version_major = ?", "version_minor = ?", "version_patch = ?"))
            parameters.extend(parts)
        matches = self._all(
            f"SELECT * FROM experiments WHERE {' AND '.join(clauses)} "
            "ORDER BY namespace, repository_slug, version_major DESC, version_minor DESC, version_patch DESC LIMIT 2",
            parameters,
        )
        if not matches:
            raise CatalogNotFoundError(f"Unknown Experiment: {identifier}")
        if len(matches) > 1:
            raise CatalogAmbiguousError(
                f"Ambiguous Experiment key: {identifier}; provide namespace, repository, and version"
            )
        row = matches[0]
        experiment_id = row["id"]
        result: dict[str, Any] = {
            "key": row["key"],
            "namespace": row["namespace"],
            "repository": row["repository_slug"],
            "version": f"{row['version_major']}.{row['version_minor']}.{row['version_patch']}",
            "coordinate": (
                f"caemble:experiment/{row['namespace']}/{row['repository_slug']}/{row['key']}"
                f"@{row['version_major']}.{row['version_minor']}.{row['version_patch']}"
            ),
            "title": row["title"],
            "description": row["description"],
            "cadApiVersion": row["cad_api_version"],
            "sourceFormatVersion": row["source_format_version"],
            "bundleFormatVersion": row["bundle_format_version"],
            "bundleHash": row["bundle_hash"],
            "concepts": [
                item["concept"]
                for item in self._all(
                    "SELECT concept FROM experiment_concepts WHERE experiment_id = ? ORDER BY ordinal",
                    (experiment_id,),
                )
            ],
            "relatedSolvers": [
                {
                    "name": item["solver_name"],
                    "version": item["solver_version"],
                    "description": item["description"],
                }
                for item in self._all(
                    """
                    SELECT es.solver_name, es.solver_version, s.description
                    FROM experiment_solvers es
                    JOIN solvers s ON s.name = es.solver_name AND s.version = es.solver_version
                    WHERE es.experiment_id = ? ORDER BY es.ordinal
                    """,
                    (experiment_id,),
                )
            ],
        }
        if include_bundle:
            result["verification"] = _json(row["verification_json"])
            result["sourceBundle"] = {
                "formatVersion": row["bundle_format_version"],
                "files": {
                    item["path"]: item["source"]
                    for item in self._all(
                        "SELECT path, source FROM experiment_files WHERE experiment_id = ? ORDER BY ordinal",
                        (experiment_id,),
                    )
                },
            }
        return result

    def list_experiments(
        self,
        *,
        query: str | None = None,
        solver_name: str | None = None,
        solver_version: str | None = None,
        namespace: str | None = None,
        repository: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        joins = ""
        clauses: list[str] = []
        parameters: list[object] = []
        if solver_name is not None or solver_version is not None:
            joins = " JOIN experiment_solvers es ON es.experiment_id = e.id"
        if solver_name is not None:
            clauses.append("es.solver_name = ?")
            parameters.append(solver_name)
        if solver_version is not None:
            clauses.append("es.solver_version = ?")
            parameters.append(solver_version)
        if namespace is not None:
            clauses.append("e.namespace = ?")
            parameters.append(namespace)
        if repository is not None:
            clauses.append("e.repository_slug = ?")
            parameters.append(repository)
        if query:
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            like = f"%{escaped}%"
            clauses.append(
                """(e.key LIKE ? ESCAPE '\\' OR e.namespace LIKE ? ESCAPE '\\'
                     OR e.repository_slug LIKE ? ESCAPE '\\' OR e.title LIKE ? ESCAPE '\\'
                     OR e.description LIKE ? ESCAPE '\\'
                     OR ('caemble:experiment/' || e.namespace || '/' || e.repository_slug || '/' || e.key || '@' ||
                         e.version_major || '.' || e.version_minor || '.' || e.version_patch) LIKE ? ESCAPE '\\')"""
            )
            parameters.extend((like, like, like, like, like, like))
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        total = self._one(
            f"SELECT count(DISTINCT e.id) AS value FROM experiments e{joins}{where}", parameters
        )["value"]
        rows = self._all(
            f"""SELECT DISTINCT e.key, e.namespace, e.repository_slug,
                       e.version_major, e.version_minor, e.version_patch
                FROM experiments e{joins}{where}
                ORDER BY e.namespace, e.repository_slug, e.key,
                         e.version_major DESC, e.version_minor DESC, e.version_patch DESC
                LIMIT ? OFFSET ?""",
            (*parameters, limit, offset),
        )
        return [
            self.experiment(
                row["key"],
                namespace=row["namespace"],
                repository=row["repository_slug"],
                version=f"{row['version_major']}.{row['version_minor']}.{row['version_patch']}",
                include_bundle=False,
            )
            for row in rows
        ], total

    def search(self, query: str, *, limit: int = 30) -> list[dict[str, str]]:
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{escaped}%"
        rows = self._all(
            """
            SELECT kind, key, title, subtitle FROM (
              SELECT 'quantityKind' AS kind, name AS key, name AS title,
                     domain || ' · QuantityKind' AS subtitle, name AS sort_key
              FROM quantity_kinds WHERE name LIKE ? ESCAPE '\\' OR coalesce(description, '') LIKE ? ESCAPE '\\'
              UNION ALL
              SELECT 'materialParameter', key, label_ko, key, key
              FROM material_parameters WHERE key LIKE ? ESCAPE '\\' OR label_ko LIKE ? ESCAPE '\\'
              UNION ALL
              SELECT 'materialModel', key, label_ko, key, key
              FROM material_models WHERE key LIKE ? ESCAPE '\\' OR label_ko LIKE ? ESCAPE '\\'
              UNION ALL
              SELECT 'solver', name || '@' || version, name, version || ' · Solver', name
              FROM solvers WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
              UNION ALL
              SELECT 'experiment',
                     'caemble:experiment/' || namespace || '/' || repository_slug || '/' || key || '@' ||
                       version_major || '.' || version_minor || '.' || version_patch,
                     title,
                     'Example Experiment · ' || namespace || '/' || repository_slug || '@' ||
                       version_major || '.' || version_minor || '.' || version_patch,
                     namespace || '/' || repository_slug || '/' || key || '@' ||
                       version_major || '.' || version_minor || '.' || version_patch
              FROM experiments
              WHERE key LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
                 OR ('caemble:experiment/' || namespace || '/' || repository_slug || '/' || key || '@' ||
                     version_major || '.' || version_minor || '.' || version_patch) LIKE ? ESCAPE '\\'
            ) ORDER BY sort_key, kind LIMIT ?
            """,
            (like, like, like, like, like, like, like, like, like, like, like, like, limit),
        )
        return [dict(row) for row in rows]

    def runtime_slice(
        self,
        *,
        solvers: Sequence[tuple[str, str]],
        quantity_kinds: Sequence[str],
        material_parameters: Sequence[str],
        material_models: Sequence[str] = (),
    ) -> dict[str, Any]:
        manifests = [self.get_solver_manifest(name, version) for name, version in dict.fromkeys(solvers)]
        material_names = set(material_parameters)
        quantity_names = set(quantity_kinds)
        for manifest in manifests:
            name = manifest["descriptor"]["name"]
            version = manifest["descriptor"]["version"]
            quantity_names.update(
                row["quantity_kind"]
                for row in self._all(
                    "SELECT DISTINCT quantity_kind FROM solver_quantity_kind_usages WHERE solver_name = ? AND solver_version = ?",
                    (name, version),
                )
            )
            material_names.update(
                row["material_parameter"]
                for row in self._all(
                    "SELECT DISTINCT material_parameter FROM solver_material_properties WHERE solver_name = ? AND solver_version = ?",
                    (name, version),
                )
            )
        materials = [self.material_parameter(key) for key in sorted(material_names)]
        quantity_names.update(item["quantityKind"] for item in materials)
        models = [self.material_model(key) for key in sorted(dict.fromkeys(material_models))]
        for model in models:
            quantity_names.add(model["input"]["quantityKind"])
            quantity_names.add(model["output"]["quantityKind"])
        quantities = [self.quantity_kind(name) for name in sorted(quantity_names)]
        selected_solvers = {item for item in dict.fromkeys(solvers)}
        warnings: list[str] = []
        for key in material_parameters:
            usages = {
                (row["solver_name"], row["solver_version"])
                for row in self._all(
                    "SELECT solver_name, solver_version FROM solver_material_properties WHERE material_parameter = ?",
                    (key,),
                )
            }
            if selected_solvers and usages.isdisjoint(selected_solvers):
                warnings.append(f"Material parameter {key} is valid but unused by the selected Solver(s).")
        for name in quantity_kinds:
            usages = {
                (row["solver_name"], row["solver_version"])
                for row in self._all(
                    "SELECT solver_name, solver_version FROM solver_quantity_kind_usages WHERE quantity_kind = ?",
                    (name,),
                )
            }
            if selected_solvers and usages.isdisjoint(selected_solvers):
                warnings.append(f"QuantityKind {name} is valid but unused by the selected Solver(s).")
        if selected_solvers:
            warnings.extend(
                f"Material model {key} is valid but unused by the selected Solver(s)."
                for key in dict.fromkeys(material_models)
            )
        meta = self.meta()
        return {
            "schemaVersion": RUNTIME_SLICE_SCHEMA_VERSION,
            "catalogRevision": meta["catalogRevision"],
            "solvers": [
                {
                    "name": manifest["descriptor"]["name"],
                    "version": manifest["descriptor"]["version"],
                    "contractDigest": self.solver_contract_digest(
                        manifest["descriptor"]["name"], manifest["descriptor"]["version"]
                    ),
                    "descriptor": manifest["descriptor"],
                }
                for manifest in manifests
            ],
            "quantityKinds": quantities,
            "materialParameters": materials,
            "materialModels": models,
            "materialGlobalQualifiers": meta["materialGlobalQualifiers"],
            "warnings": warnings,
        }


def open_catalog(path: Path | str | None = None, *, immutable: bool = True) -> Catalog:
    return Catalog.open_readonly(path, immutable=immutable)
