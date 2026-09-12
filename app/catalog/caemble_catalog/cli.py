from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any, Callable

from .admin import (
    create_draft,
    insert_experiment,
    insert_material_model,
    insert_solver_manifest,
    publish_draft,
    rebase_database,
    refresh_derived_data,
    writable_connection,
)
from .database import Catalog
from .errors import CatalogError, CatalogNotFoundError
from .schema import (
    EXPERIMENT_COORDINATE_PREFIX,
    parse_experiment_coordinate,
    parse_experiment_version,
)


def _data(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise argparse.ArgumentTypeError(f"invalid JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError("data descriptor must be a JSON object")
    return parsed


def _load_manifest(database: Path, name: str, version: str) -> dict[str, Any]:
    with Catalog.open_readonly(database, immutable=False) as catalog:
        return catalog.get_solver_manifest(name, version)


def _replace_manifest(
    database: Path,
    identity: tuple[str, str] | None,
    manifest: dict[str, Any] | None,
) -> None:
    with writable_connection(database) as connection:
        references = []
        if identity is not None:
            references = connection.execute(
                """
                SELECT experiment_id, ordinal, solver_name, solver_version
                FROM experiment_solvers WHERE solver_name = ? AND solver_version = ? ORDER BY experiment_id
                """,
                identity,
            ).fetchall()
            replacement = None if manifest is None else (
                manifest["descriptor"]["name"],
                manifest["descriptor"]["version"],
            )
            if references and replacement != identity:
                raise CatalogError(
                    f"Solver {identity[0]}@{identity[1]} is referenced by Example Experiment entries"
                )
            connection.execute(
                "DELETE FROM experiment_solvers WHERE solver_name = ? AND solver_version = ?", identity
            )
            cursor = connection.execute("DELETE FROM solvers WHERE name = ? AND version = ?", identity)
            if cursor.rowcount != 1:
                raise CatalogNotFoundError(f"Unknown Solver: {identity[0]}@{identity[1]}")
        if manifest is not None:
            insert_solver_manifest(connection, manifest)
            connection.executemany(
                """INSERT INTO experiment_solvers(
                       experiment_id, ordinal, solver_name, solver_version
                   ) VALUES (?, ?, ?, ?)""",
                [
                    (row["experiment_id"], row["ordinal"], row["solver_name"], row["solver_version"])
                    for row in references
                ],
            )
    refresh_derived_data(database)


def _mutate(
    database: Path,
    name: str,
    version: str,
    operation: Callable[[dict[str, Any]], None],
) -> None:
    manifest = _load_manifest(database, name, version)
    operation(manifest)
    _replace_manifest(database, (name, version), manifest)


def _named_upsert(values: dict[str, Any], key: str, value: dict[str, Any]) -> None:
    values[key] = value


def _named_remove(values: dict[str, Any], key: str, label: str) -> None:
    if key not in values:
        raise CatalogNotFoundError(f"Unknown {label}: {key}")
    del values[key]


def _material_role(descriptor: dict[str, Any], role: str) -> dict[str, Any]:
    for item in descriptor["materials"]:
        if item["role"] == role:
            return item
    raise CatalogNotFoundError(f"Unknown Solver material role: {role}")


def _method(descriptor: dict[str, Any], category: str, method_id: str) -> dict[str, Any]:
    for item in descriptor["methods"][category]:
        if item["methodId"] == method_id:
            return item
    raise CatalogNotFoundError(f"Unknown Solver method: {category}/{method_id}")


def _run_query(args: argparse.Namespace) -> Any:
    with Catalog.open_readonly(args.database, immutable=False) as catalog:
        if args.resource == "meta":
            return catalog.meta()
        if not args.key:
            if args.resource == "solver":
                return catalog.list_solvers()
            if args.resource == "experiment":
                return catalog.list_experiments(limit=10_000)[0]
            if args.resource == "material-model":
                return catalog.material_models()
            if args.resource == "artifact-type":
                return catalog.artifact_types()
            raise CatalogError(f"{args.resource} query requires KEY")
        if args.resource == "quantity-kind":
            return {**catalog.quantity_kind(args.key), **catalog.quantity_kind_relations(args.key)}
        if args.resource == "material-model":
            return {**catalog.material_model(args.key), **catalog.material_model_relations(args.key)}
        if args.resource == "artifact-type":
            return catalog.artifact_type(args.key)
        if args.resource == "experiment":
            return catalog.experiment(
                args.key,
                namespace=args.namespace,
                repository=args.repository,
                version=args.version,
            )
        if not args.version:
            raise CatalogError("solver query requires VERSION")
        manifest = catalog.get_solver_manifest(args.key, args.version)
        return {
            **catalog.solver_detail(args.key, args.version),
            "implementation": manifest["implementation"],
            "abiVersion": manifest["abiVersion"],
        }


def _load_json_file(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise CatalogError(f"Unable to read {label} as UTF-8 JSON: {path}: {error}") from error
    if not isinstance(value, dict):
        raise CatalogError(f"{label} must contain a JSON object: {path}")
    return value


def _edit_experiment(args: argparse.Namespace) -> None:
    with writable_connection(args.database) as connection:
        if args.experiment_action == "remove":
            key = args.key
            namespace = args.namespace
            repository = args.repository
            version_text = args.version
            if key.startswith(EXPERIMENT_COORDINATE_PREFIX):
                try:
                    coordinate_namespace, coordinate_repository, coordinate_key, coordinate_version = (
                        parse_experiment_coordinate(key)
                    )
                except ValueError as error:
                    raise CatalogError(f"Invalid Experiment coordinate: {key}: {error}") from error
                if (
                    (namespace is not None and namespace != coordinate_namespace)
                    or (repository is not None and repository != coordinate_repository)
                    or (version_text is not None and version_text != coordinate_version)
                ):
                    raise CatalogError(f"Conflicting Experiment coordinate selector: {key}")
                namespace = coordinate_namespace
                repository = coordinate_repository
                key = coordinate_key
                version_text = coordinate_version

            clauses = ["key = ?"]
            parameters: list[object] = [key]
            if namespace is not None:
                clauses.append("namespace = ?")
                parameters.append(namespace)
            if repository is not None:
                clauses.append("repository_slug = ?")
                parameters.append(repository)
            if version_text is not None:
                try:
                    version = parse_experiment_version(version_text)
                except ValueError as error:
                    raise CatalogError(str(error)) from error
                clauses.extend(("version_major = ?", "version_minor = ?", "version_patch = ?"))
                parameters.extend(version)
            matches = connection.execute(
                f"SELECT id FROM experiments WHERE {' AND '.join(clauses)} LIMIT 2", parameters
            ).fetchall()
            if not matches:
                raise CatalogNotFoundError(f"Unknown Experiment: {key}")
            if len(matches) > 1:
                raise CatalogError(
                    f"Ambiguous Experiment key: {args.key}; provide --namespace, --repository, and --version"
                )
            connection.execute("DELETE FROM experiments WHERE id = ?", (matches[0]["id"],))
        else:
            related_solvers = []
            for value in args.solver:
                name, separator, version = value.rpartition("@")
                if not separator or not name or not version:
                    raise CatalogError("--solver must use NAME@VERSION")
                related_solvers.append({"name": name, "version": version})
            try:
                version = parse_experiment_version(args.version)
            except ValueError as error:
                raise CatalogError(str(error)) from error
            if args.calculations_file is not None:
                try:
                    calculations = json.loads(args.calculations_file.read_text(encoding="utf-8"))
                except (OSError, ValueError) as error:
                    raise CatalogError(f"Cannot read Calculation definitions: {error}") from error
            else:
                calculations = [dict(row) for row in connection.execute(
                    """SELECT c.name, c.description, c.source_code FROM experiment_calculations c
                       JOIN experiments e ON e.id = c.experiment_id
                       WHERE e.key = ? AND e.namespace = ? AND e.repository_slug = ?
                         AND e.version_major = ? AND e.version_minor = ? AND e.version_patch = ?
                       ORDER BY c.ordinal""",
                    (args.key, args.namespace, args.repository, *version),
                )]
            connection.execute(
                """DELETE FROM experiments
                   WHERE key = ? AND namespace = ? AND repository_slug = ?
                     AND version_major = ? AND version_minor = ? AND version_patch = ?""",
                (args.key, args.namespace, args.repository, *version),
            )
            insert_experiment(
                connection,
                {
                    "key": args.key,
                    "namespace": args.namespace,
                    "repository": args.repository,
                    "version": args.version,
                    "title": args.title,
                    "description": args.description,
                    "concepts": args.concept,
                    "relatedSolvers": related_solvers,
                    "sourceBundle": _load_json_file(args.bundle_file, "Experiment source bundle"),
                    "calculations": calculations,
                },
            )
    refresh_derived_data(args.database)


def _run_solver(args: argparse.Namespace) -> None:
    action = args.solver_action
    database = args.database
    if action == "create":
        manifest = {
            "implementation": args.implementation,
            "abiVersion": args.implementation_abi,
            "descriptor": {
                "name": args.name,
                "version": args.version,
                "description": args.description,
                "referenceLengthUnit": args.reference_length_unit,
                "minimumOutputs": args.minimum_outputs,
                "parameters": {},
                "materials": [],
                "inputPorts": {},
                "observations": {},
                "methods": {"initializations": [], "boundaryConditions": [], "outputs": [], "exports": []},
                "visualizations": {},
            },
        }
        _replace_manifest(database, None, manifest)
        return
    if action == "clone":
        manifest = _load_manifest(database, args.name, args.version)
        manifest["descriptor"]["version"] = args.new_version
        _replace_manifest(database, None, manifest)
        return
    if action == "remove":
        _replace_manifest(database, (args.name, args.version), None)
        return
    if action == "set-metadata":
        def update_metadata(manifest: dict[str, Any]) -> None:
            descriptor = manifest["descriptor"]
            for attribute, field in (
                ("implementation", None),
                ("implementation_abi", None),
                ("description", "description"),
                ("reference_length_unit", "referenceLengthUnit"),
                ("minimum_outputs", "minimumOutputs"),
            ):
                value = getattr(args, attribute)
                if value is not None:
                    if field is None:
                        manifest["abiVersion" if attribute == "implementation_abi" else "implementation"] = value
                    else:
                        descriptor[field] = value

        _mutate(database, args.name, args.version, update_metadata)
        return
    handler = {
        "parameter": _edit_parameter,
        "material-role": _edit_material_role,
        "material-model-group": _edit_material_model_group,
            "material-model-option": _edit_material_model_option,
        "method": _edit_method,
        "method-parameter": _edit_method_parameter,
        "input-port": _edit_input_port,
        "observation": _edit_observation,
        "visualization": _edit_visualization,
    }[action]
    handler(args)


def _replace_sequence(
    connection: sqlite3.Connection,
    table: str,
    owner_column: str | None,
    owner: str | None,
    value_column: str,
    values: list[str],
) -> None:
    if len(values) != len(set(values)):
        raise CatalogError(f"{value_column} values must be unique")
    if owner_column is None:
        connection.execute(f"DELETE FROM {table}")
        connection.executemany(
            f"INSERT INTO {table}(ordinal, {value_column}) VALUES (?, ?)",
            enumerate(values),
        )
    else:
        connection.execute(f"DELETE FROM {table} WHERE {owner_column} = ?", (owner,))
        connection.executemany(
            f"INSERT INTO {table}({owner_column}, ordinal, {value_column}) VALUES (?, ?, ?)",
            ((owner, ordinal, value) for ordinal, value in enumerate(values)),
        )


def _edit_quantity_kind(args: argparse.Namespace) -> None:
    with writable_connection(args.database) as connection:
        if args.quantity_kind_action == "upsert":
            connection.execute(
                """
                INSERT INTO quantity_kinds(name, domain, tensor_order, description, opaque) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET domain=excluded.domain, tensor_order=excluded.tensor_order,
                  description=excluded.description, opaque=excluded.opaque
                """,
                (args.name, args.domain, args.tensor_order, args.description, int(args.opaque)),
            )
            _replace_sequence(
                connection, "quantity_kind_units", "quantity_kind", args.name, "unit", args.unit
            )
        elif args.quantity_kind_action == "remove":
            if connection.execute("DELETE FROM quantity_kinds WHERE name = ?", (args.name,)).rowcount != 1:
                raise CatalogNotFoundError(f"Unknown QuantityKind: {args.name}")
        else:
            rows = connection.execute(
                "SELECT unit FROM quantity_kind_units WHERE quantity_kind = ? ORDER BY ordinal", (args.name,)
            ).fetchall()
            if not connection.execute("SELECT 1 FROM quantity_kinds WHERE name = ?", (args.name,)).fetchone():
                raise CatalogNotFoundError(f"Unknown QuantityKind: {args.name}")
            units = [row["unit"] for row in rows]
            if args.unit_action == "add":
                if args.unit_value in units:
                    raise CatalogError(f"Unit already exists for {args.name}: {args.unit_value}")
                position = len(units) if args.position is None else args.position
                if position < 0 or position > len(units):
                    raise CatalogError("Unit position is outside the applicable unit list")
                units.insert(position, args.unit_value)
            elif args.unit_action == "remove":
                if args.unit_value not in units:
                    raise CatalogNotFoundError(f"Unknown unit for {args.name}: {args.unit_value}")
                units.remove(args.unit_value)
            else:
                if set(args.units) != set(units) or len(args.units) != len(units):
                    raise CatalogError("Reorder must contain every existing unit exactly once")
                units = args.units
            _replace_sequence(connection, "quantity_kind_units", "quantity_kind", args.name, "unit", units)
    refresh_derived_data(args.database)


def _edit_material_model(args: argparse.Namespace) -> None:
    with writable_connection(args.database) as connection:
        if args.material_model_action == "remove":
            if connection.execute("DELETE FROM material_models WHERE key = ?", (args.key,)).rowcount != 1:
                raise CatalogNotFoundError(f"Unknown Material model: {args.key}")
        else:
            insert_material_model(connection, {
                "key": args.key, "labelKo": args.label_ko, "description": args.description,
                "equation": args.equation, "conventions": args.conventions,
                "parameterSchema": args.schema_json,
            })
    refresh_derived_data(args.database)


def _edit_metadata(args: argparse.Namespace) -> None:
    with writable_connection(args.database) as connection:
        connection.execute("UPDATE catalog_metadata SET value = ? WHERE key = ?", (args.value, args.key))
    refresh_derived_data(args.database)


def _edit_parameter(args: argparse.Namespace) -> None:
    def operation(manifest: dict[str, Any]) -> None:
        values = manifest["descriptor"]["parameters"]
        if args.row_action == "remove":
            _named_remove(values, args.parameter, "Solver parameter")
        else:
            _named_upsert(values, args.parameter, {"description": args.description, "data": args.data_json})

    _mutate(args.database, args.name, args.version, operation)


def _edit_material_role(args: argparse.Namespace) -> None:
    def operation(manifest: dict[str, Any]) -> None:
        values = manifest["descriptor"]["materials"]
        existing = next((item for item in values if item["role"] == args.role), None)
        if args.row_action == "remove":
            if existing is None:
                raise CatalogNotFoundError(f"Unknown Solver material role: {args.role}")
            values.remove(existing)
        elif existing is None:
            values.append(
                {
                    "role": args.role,
                    "description": args.description,
                    "target": {"category": args.target_category, **({"source": args.target_source} if args.target_category == "geometry" else {"methodId": args.target_method_id})},
                    "modelGroups": [],
                }
            )
        else:
            existing.update(
                description=args.description,
                target={"category": args.target_category, **({"source": args.target_source} if args.target_category == "geometry" else {"methodId": args.target_method_id})},
            )

    _mutate(args.database, args.name, args.version, operation)


def _edit_material_model_group(args: argparse.Namespace) -> None:
    def operation(manifest: dict[str, Any]) -> None:
        groups = _material_role(manifest["descriptor"], args.role)["modelGroups"]
        existing = next((group for group in groups if group["key"] == args.group), None)
        if args.row_action == "remove":
            if existing is None:
                raise CatalogNotFoundError(f"Unknown model group: {args.group}")
            groups.remove(existing)
        else:
            if not args.model or len(args.model) != len(set(args.model)):
                raise CatalogError("A model group requires unique --model options")
            value = {"key": args.group, "required": args.required, "oneOf": args.model}
            if existing is None:
                groups.append(value)
            else:
                existing.update(value)
    _mutate(args.database, args.name, args.version, operation)


def _edit_material_model_option(args: argparse.Namespace) -> None:
    def operation(manifest: dict[str, Any]) -> None:
        groups = _material_role(manifest["descriptor"], args.role)["modelGroups"]
        group = next((item for item in groups if item["key"] == args.group), None)
        if group is None:
            raise CatalogNotFoundError(f"Unknown model group: {args.group}")
        if args.row_action == "remove":
            if args.model not in group["oneOf"]:
                raise CatalogNotFoundError(f"Unknown model option: {args.model}")
            if len(group["oneOf"]) == 1:
                raise CatalogError("A model group must retain at least one option")
            group["oneOf"].remove(args.model)
        elif args.model not in group["oneOf"]:
            group["oneOf"].append(args.model)
    _mutate(args.database, args.name, args.version, operation)


def _edit_method(args: argparse.Namespace) -> None:
    def operation(manifest: dict[str, Any]) -> None:
        values = manifest["descriptor"]["methods"][args.category]
        existing = next((item for item in values if item["methodId"] == args.method_id), None)
        if args.row_action == "remove":
            if existing is None:
                raise CatalogNotFoundError(f"Unknown Solver method: {args.category}/{args.method_id}")
            values.remove(existing)
            return
        item = existing or {"methodId": args.method_id, "parameters": {}}
        item.update(
            description=args.description,
            minimumOccurrences=args.minimum_occurrences,
            maximumOccurrences=args.maximum_occurrences,
            target={
                "source": args.target_source,
                "kind": args.target_kind,
                "minimumTargets": args.minimum_targets,
                "maximumTargets": args.maximum_targets,
                "minimumResolved": args.minimum_resolved,
                "maximumResolved": args.maximum_resolved,
            },
        )
        if args.artifact_type is not None:
            item["artifactType"] = args.artifact_type
        else:
            item.pop("artifactType", None)
        if args.data_json is not None:
            item["data"] = args.data_json
        else:
            item.pop("data", None)
        if existing is None:
            values.append(item)

    _mutate(args.database, args.name, args.version, operation)


def _edit_method_parameter(args: argparse.Namespace) -> None:
    def operation(manifest: dict[str, Any]) -> None:
        values = _method(manifest["descriptor"], args.category, args.method_id)["parameters"]
        if args.row_action == "remove":
            _named_remove(values, args.parameter, "Solver method parameter")
        else:
            _named_upsert(values, args.parameter, {"description": args.description, "data": args.data_json})

    _mutate(args.database, args.name, args.version, operation)


def _edit_input_port(args: argparse.Namespace) -> None:
    def operation(manifest: dict[str, Any]) -> None:
        values = manifest["descriptor"]["inputPorts"]
        if args.row_action == "remove":
            _named_remove(values, args.input_port, "Solver input port")
        else:
            _named_upsert(
                values,
                args.input_port,
                {
                    "description": args.description,
                    "artifactTypes": args.artifact_type,
                    "minimumOccurrences": args.minimum_occurrences,
                    "maximumOccurrences": args.maximum_occurrences,
                    "data": args.data_json,
                },
            )

    _mutate(args.database, args.name, args.version, operation)


def _edit_observation(args: argparse.Namespace) -> None:
    def operation(manifest: dict[str, Any]) -> None:
        values = manifest["descriptor"]["observations"]
        if args.row_action == "remove":
            _named_remove(values, args.observation, "Solver observation")
        else:
            _named_upsert(values, args.observation, {"description": args.description, "type": args.type})

    _mutate(args.database, args.name, args.version, operation)


def _edit_visualization(args: argparse.Namespace) -> None:
    def operation(manifest: dict[str, Any]) -> None:
        values = manifest["descriptor"].setdefault("visualizations", {})
        if args.row_action == "remove":
            _named_remove(values, args.key, "Solver visualization")
        else:
            _named_upsert(values, args.key, {"artifactType": args.artifact_type, "data": args.data_json})
    _mutate(args.database, args.name, args.version, operation)


def _identity(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("name")
    parser.add_argument("version")


def _row_actions(parser: argparse.ArgumentParser) -> tuple[argparse.ArgumentParser, argparse.ArgumentParser]:
    actions = parser.add_subparsers(dest="row_action", required=True)
    return actions.add_parser("upsert"), actions.add_parser("remove")


def _descriptor(upsert: argparse.ArgumentParser, *, optional: bool = False) -> None:
    upsert.add_argument("--description", required=not optional)
    upsert.add_argument("--data-json", type=_data, required=not optional)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="catalogctl", description="Manage a CAE catalog SQLite file.")
    parser.add_argument("--database", type=Path, required=True, help="explicit SQLite path")
    commands = parser.add_subparsers(dest="command", required=True)

    draft = commands.add_parser("draft")
    draft_actions = draft.add_subparsers(dest="draft_action", required=True)
    create = draft_actions.add_parser("create")
    create.add_argument("--source", type=Path, required=True)

    commands.add_parser("rebase")
    publish = commands.add_parser("publish")
    publish.add_argument("--destination", type=Path, required=True)
    query = commands.add_parser("query")
    query.add_argument(
        "resource",
        choices=("meta", "quantity-kind", "material-model", "artifact-type", "solver", "experiment"),
    )
    query.add_argument("key", nargs="?")
    query.add_argument("version", nargs="?")
    query.add_argument("--namespace")
    query.add_argument("--repository")

    experiment = commands.add_parser("experiment")
    experiment_actions = experiment.add_subparsers(dest="experiment_action", required=True)
    upsert = experiment_actions.add_parser("upsert")
    upsert.add_argument("key")
    upsert.add_argument("--namespace", default="caemble")
    upsert.add_argument("--repository", default="verified")
    upsert.add_argument("--version", default="1.0.0")
    upsert.add_argument("--title", required=True)
    upsert.add_argument("--description", required=True)
    upsert.add_argument("--bundle-file", type=Path, required=True)
    upsert.add_argument("--calculations-file", type=Path, help="Calculation definition list; omitted preserves existing definitions")
    upsert.add_argument("--concept", action="append", default=[])
    upsert.add_argument("--solver", action="append", default=[])
    remove = experiment_actions.add_parser("remove")
    remove.add_argument("key")
    remove.add_argument("--namespace")
    remove.add_argument("--repository")
    remove.add_argument("--version")

    solver = commands.add_parser("solver")
    solver_actions = solver.add_subparsers(dest="solver_action", required=True)
    create_solver = solver_actions.add_parser("create")
    _identity(create_solver)
    create_solver.add_argument("--implementation", required=True)
    create_solver.add_argument("--implementation-abi", type=int, default=3)
    create_solver.add_argument("--description", required=True)
    create_solver.add_argument("--reference-length-unit", default="m")
    create_solver.add_argument("--minimum-outputs", type=int, default=1)
    clone = solver_actions.add_parser("clone")
    _identity(clone)
    clone.add_argument("new_version")
    remove_solver = solver_actions.add_parser("remove")
    _identity(remove_solver)
    metadata = solver_actions.add_parser("set-metadata")
    _identity(metadata)
    metadata.add_argument("--implementation")
    metadata.add_argument("--implementation-abi", type=int)
    metadata.add_argument("--description")
    metadata.add_argument("--reference-length-unit")
    metadata.add_argument("--minimum-outputs", type=int)

    parameter = solver_actions.add_parser("parameter")
    upsert, remove = _row_actions(parameter)
    for item in (upsert, remove):
        _identity(item)
        item.add_argument("parameter")
    _descriptor(upsert)

    role = solver_actions.add_parser("material-role")
    upsert, remove = _row_actions(role)
    for item in (upsert, remove):
        _identity(item)
        item.add_argument("role")
    upsert.add_argument("--description", required=True)
    upsert.add_argument("--target-category", choices=("initializations", "boundaryConditions", "outputs", "geometry"), required=True)
    upsert.add_argument("--target-method-id")
    upsert.add_argument("--target-source", choices=("experiment", "task"))

    group = solver_actions.add_parser("material-model-group")
    upsert, remove = _row_actions(group)
    for item in (upsert, remove):
        _identity(item)
        item.add_argument("role")
        item.add_argument("group")
    upsert.add_argument("--required", action=argparse.BooleanOptionalAction, default=True)
    upsert.add_argument("--model", action="append", required=True)

    option = solver_actions.add_parser("material-model-option")
    upsert, remove = _row_actions(option)
    for item in (upsert, remove):
        _identity(item)
        item.add_argument("role")
        item.add_argument("group")
        item.add_argument("model")

    method = solver_actions.add_parser("method")
    upsert, remove = _row_actions(method)
    for item in (upsert, remove):
        _identity(item)
        item.add_argument("category", choices=("initializations", "boundaryConditions", "outputs", "exports"))
        item.add_argument("method_id")
    upsert.add_argument("--description", required=True)
    upsert.add_argument("--minimum-occurrences", type=int, required=True)
    upsert.add_argument("--maximum-occurrences", type=int, required=True)
    upsert.add_argument("--target-source", required=True)
    upsert.add_argument("--target-kind", required=True)
    upsert.add_argument("--minimum-targets", type=int, required=True)
    upsert.add_argument("--maximum-targets", type=int, required=True)
    upsert.add_argument("--minimum-resolved", type=int, required=True)
    upsert.add_argument("--maximum-resolved", type=int, required=True)
    upsert.add_argument("--artifact-type")
    upsert.add_argument("--data-json", type=_data)

    method_parameter = solver_actions.add_parser("method-parameter")
    upsert, remove = _row_actions(method_parameter)
    for item in (upsert, remove):
        _identity(item)
        item.add_argument("category", choices=("initializations", "boundaryConditions", "outputs", "exports"))
        item.add_argument("method_id")
        item.add_argument("parameter")
    _descriptor(upsert)

    visualization = solver_actions.add_parser("visualization")
    upsert, remove = _row_actions(visualization)
    for item in (upsert, remove):
        _identity(item)
        item.add_argument("key")
    upsert.add_argument("--artifact-type", required=True)
    upsert.add_argument("--data-json", type=_data, required=True)

    input_port = solver_actions.add_parser("input-port")
    upsert, remove = _row_actions(input_port)
    for item in (upsert, remove):
        _identity(item)
        item.add_argument("input_port")
    _descriptor(upsert)
    upsert.add_argument("--artifact-type", action="append", default=[])
    upsert.add_argument("--minimum-occurrences", type=int, required=True)
    upsert.add_argument("--maximum-occurrences", type=int, required=True)

    observation = solver_actions.add_parser("observation")
    upsert, remove = _row_actions(observation)
    for item in (upsert, remove):
        _identity(item)
        item.add_argument("observation")
    upsert.add_argument("--description", required=True)
    upsert.add_argument("--type", choices=("number", "string", "boolean"), required=True)

    quantity_kind = commands.add_parser("quantity-kind")
    quantity_actions = quantity_kind.add_subparsers(dest="quantity_kind_action", required=True)
    upsert = quantity_actions.add_parser("upsert")
    upsert.add_argument("name")
    upsert.add_argument("--domain", required=True)
    upsert.add_argument("--tensor-order", type=int, required=True)
    upsert.add_argument("--description")
    upsert.add_argument("--opaque", action=argparse.BooleanOptionalAction, default=False)
    upsert.add_argument("--unit", action="append", default=[])
    remove = quantity_actions.add_parser("remove")
    remove.add_argument("name")
    unit = quantity_actions.add_parser("unit")
    unit_actions = unit.add_subparsers(dest="unit_action", required=True)
    add = unit_actions.add_parser("add")
    add.add_argument("name")
    add.add_argument("unit_value")
    add.add_argument("--position", type=int)
    remove = unit_actions.add_parser("remove")
    remove.add_argument("name")
    remove.add_argument("unit_value")
    reorder = unit_actions.add_parser("reorder")
    reorder.add_argument("name")
    reorder.add_argument("units", nargs="+")

    material_model = commands.add_parser("material-model")
    material_model_actions = material_model.add_subparsers(dest="material_model_action", required=True)
    upsert = material_model_actions.add_parser("upsert")
    upsert.add_argument("key")
    upsert.add_argument("--label-ko", required=True)
    upsert.add_argument("--description", required=True)
    upsert.add_argument("--equation", required=True)
    upsert.add_argument("--conventions", required=True)
    upsert.add_argument("--schema-json", type=_data, required=True)
    remove = material_model_actions.add_parser("remove")
    remove.add_argument("key")

    metadata = commands.add_parser("metadata")
    metadata.add_argument("key", choices=("quantityKindDataVersion", "materialCatalogVersion"))
    metadata.add_argument("value")
    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "draft":
            create_draft(args.database, args.source)
            result: Any = {"draft": str(args.database.resolve())}
        elif args.command == "rebase":
            rebase_database(args.database)
            result = {"rebased": str(args.database.resolve())}
        elif args.command == "publish":
            result = publish_draft(args.database, args.destination)
        elif args.command == "query":
            result = _run_query(args)
        elif args.command == "solver":
            _run_solver(args)
            result = {"updated": str(args.database.resolve())}
        else:
            handler = {
                "quantity-kind": _edit_quantity_kind,
                "material-model": _edit_material_model,
                "metadata": _edit_metadata,
                "experiment": _edit_experiment,
            }[args.command]
            handler(args)
            result = {"updated": str(args.database.resolve())}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (CatalogError, sqlite3.Error, ValueError, KeyError) as error:
        print(f"catalogctl: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
