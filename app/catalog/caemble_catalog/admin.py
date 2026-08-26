from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable

from .database import Catalog
from .errors import CatalogError, CatalogNotFoundError
from .schema import APPLICATION_ID, TABLE_ORDER, create_schema, parse_experiment_version


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _insert_data_usages(
    connection: sqlite3.Connection,
    solver: tuple[str, str],
    data: dict[str, Any],
    context: str,
    path: str,
    ordinal: int,
) -> int:
    if quantity_kind := data.get("quantityKind"):
        connection.execute(
            "INSERT INTO solver_quantity_kind_usages VALUES (?, ?, ?, ?, ?, ?, ?)",
            (*solver, ordinal, quantity_kind, context, path, data.get("unit")),
        )
        ordinal += 1
    for axis_index, axis in enumerate(data.get("axes", [])):
        if quantity_kind := axis.get("quantityKind"):
            connection.execute(
                "INSERT INTO solver_quantity_kind_usages VALUES (?, ?, ?, ?, 'axis', ?, ?)",
                (*solver, ordinal, quantity_kind, f"{path}.axes[{axis_index}]", axis.get("unit")),
            )
            ordinal += 1
    return ordinal


def insert_solver_manifest(connection: sqlite3.Connection, manifest: dict[str, Any]) -> None:
    descriptor = manifest["descriptor"]
    solver = (descriptor["name"], descriptor["version"])
    connection.execute(
        """INSERT INTO solvers(
               name, version, implementation, implementation_abi, description,
               reference_length_unit, minimum_outputs
           ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            *solver,
            manifest["implementation"],
            manifest.get("abiVersion", 1),
            descriptor["description"],
            descriptor["referenceLengthUnit"],
            descriptor["minimumOutputs"],
        ),
    )
    usage_ordinal = 0
    for ordinal, (name, parameter) in enumerate(descriptor.get("parameters", {}).items()):
        data = parameter["data"]
        connection.execute(
            "INSERT INTO solver_parameters VALUES (?, ?, ?, ?, ?, ?)",
            (*solver, ordinal, name, parameter["description"], canonical_json(data)),
        )
        usage_ordinal = _insert_data_usages(
            connection, solver, data, "parameter", f"parameters.{name}", usage_ordinal
        )
    for role_ordinal, material in enumerate(descriptor.get("materials", [])):
        role = material["role"]
        target = material["target"]
        connection.execute(
            "INSERT INTO solver_material_roles VALUES (?, ?, ?, ?, ?, ?, ?)",
            (*solver, role_ordinal, role, material["description"], target["category"], target["methodId"]),
        )
        for ordinal, (key, prop) in enumerate(material.get("properties", {}).items()):
            data = prop["data"]
            connection.execute(
                "INSERT INTO solver_material_properties VALUES (?, ?, ?, ?, ?, ?, ?)",
                (*solver, role, ordinal, key, prop["description"], canonical_json(data)),
            )
            usage_ordinal = _insert_data_usages(
                connection, solver, data, "material", f"materials.{role}.properties.{key}", usage_ordinal
            )
    for port_ordinal, (name, port) in enumerate(descriptor.get("inputPorts", {}).items()):
        data = port["data"]
        connection.execute(
            "INSERT INTO solver_input_ports VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                *solver,
                port_ordinal,
                name,
                port["description"],
                port["minimumOccurrences"],
                port["maximumOccurrences"],
                canonical_json(data),
            ),
        )
        for artifact_ordinal, artifact_type in enumerate(port.get("artifactTypes", [])):
            connection.execute(
                "INSERT INTO solver_input_artifact_types VALUES (?, ?, ?, ?, ?)",
                (*solver, name, artifact_ordinal, artifact_type),
            )
        usage_ordinal = _insert_data_usages(
            connection, solver, data, "input", f"inputPorts.{name}.data", usage_ordinal
        )
    for ordinal, (name, observation) in enumerate(descriptor.get("observations", {}).items()):
        connection.execute(
            "INSERT INTO solver_observations VALUES (?, ?, ?, ?, ?, ?)",
            (*solver, ordinal, name, observation["description"], observation["type"]),
        )
    for category in ("initializations", "boundaryConditions", "outputs"):
        for ordinal, method in enumerate(descriptor.get("methods", {}).get(category, [])):
            target = method["target"]
            data = method.get("data")
            connection.execute(
                "INSERT INTO solver_methods VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    *solver,
                    category,
                    ordinal,
                    method["methodId"],
                    method["description"],
                    method["minimumOccurrences"],
                    method["maximumOccurrences"],
                    target["source"],
                    target["kind"],
                    target["minimumTargets"],
                    target["maximumTargets"],
                    target["minimumResolved"],
                    target["maximumResolved"],
                    method.get("artifactType"),
                    canonical_json(data) if data is not None else None,
                ),
            )
            for parameter_ordinal, (name, parameter) in enumerate(method.get("parameters", {}).items()):
                parameter_data = parameter["data"]
                connection.execute(
                    "INSERT INTO solver_method_parameters VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        *solver,
                        category,
                        method["methodId"],
                        parameter_ordinal,
                        name,
                        parameter["description"],
                        canonical_json(parameter_data),
                    ),
                )
                usage_ordinal = _insert_data_usages(
                    connection,
                    solver,
                    parameter_data,
                    "parameter",
                    f"methods.{category}.{method['methodId']}.parameters.{name}",
                    usage_ordinal,
                )
            if data is not None:
                usage_ordinal = _insert_data_usages(
                    connection,
                    solver,
                    data,
                    "output",
                    f"methods.{category}.{method['methodId']}.data",
                    usage_ordinal,
                )


def insert_experiment(connection: sqlite3.Connection, experiment: dict[str, Any]) -> None:
    bundle = experiment["sourceBundle"]
    bundle_hash = hashlib.sha256(canonical_json(bundle).encode("utf-8")).hexdigest()
    try:
        version = parse_experiment_version(experiment.get("version", "1.0.0"))
    except ValueError as error:
        raise CatalogError(str(error)) from error
    cursor = connection.execute(
        """INSERT INTO experiments(
               key, namespace, repository_slug, version_major, version_minor, version_patch,
               title, description, bundle_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            experiment["key"],
            experiment.get("namespace", "caemble"),
            experiment.get("repository", "verified"),
            *version,
            experiment["title"],
            experiment["description"],
            bundle_hash,
        ),
    )
    experiment_id = cursor.lastrowid
    connection.executemany(
        "INSERT INTO experiment_files(experiment_id, ordinal, path, source) VALUES (?, ?, ?, ?)",
        [
            (experiment_id, ordinal, path, source)
            for ordinal, (path, source) in enumerate(sorted(bundle["files"].items()))
        ],
    )
    connection.executemany(
        "INSERT INTO experiment_concepts(experiment_id, ordinal, concept) VALUES (?, ?, ?)",
        [(experiment_id, ordinal, value) for ordinal, value in enumerate(experiment.get("concepts", []))],
    )
    connection.executemany(
        """INSERT INTO experiment_solvers(
               experiment_id, ordinal, solver_name, solver_version
           ) VALUES (?, ?, ?, ?)""",
        [
            (experiment_id, ordinal, value["name"], value["version"])
            for ordinal, value in enumerate(experiment.get("relatedSolvers", []))
        ],
    )


def create_database(path: Path, dataset: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    connection = sqlite3.connect(path)
    try:
        create_schema(connection)
        with connection:
            quantity_kinds = dataset["quantityKinds"]
            opaque_names = set(dataset["opaqueQuantityKindNames"])
            for name in sorted(quantity_kinds):
                definition = quantity_kinds[name]
                connection.execute(
                    "INSERT INTO quantity_kinds VALUES (?, ?, ?, ?, ?)",
                    (
                        name,
                        definition["domain"],
                        definition["tensorOrder"],
                        definition.get("description"),
                        int(name in opaque_names),
                    ),
                )
                for ordinal, unit in enumerate(definition["applicableUnits"]):
                    connection.execute("INSERT INTO quantity_kind_units VALUES (?, ?, ?)", (name, ordinal, unit))
            for definition in dataset["materialParameters"]:
                connection.execute(
                    "INSERT INTO material_parameters VALUES (?, ?, ?, ?)",
                    (
                        definition["key"],
                        definition["key"].split(".", 1)[0],
                        definition["label_ko"],
                        definition["quantity_kind"],
                    ),
                )
                for ordinal, qualifier in enumerate(definition.get("special_qualifiers", [])):
                    connection.execute(
                        "INSERT INTO material_parameter_qualifiers VALUES (?, ?, ?)",
                        (definition["key"], ordinal, qualifier),
                    )
            for ordinal, qualifier in enumerate(dataset["materialGlobalQualifiers"]):
                connection.execute("INSERT INTO material_global_qualifiers VALUES (?, ?)", (ordinal, qualifier))
            for key, description in dataset["materialDesignRules"].items():
                connection.execute("INSERT INTO material_design_rules VALUES (?, ?)", (key, description))
            for relation in dataset["materialModels"]:
                connection.execute(
                    "INSERT INTO material_models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        relation["key"],
                        relation["label_ko"],
                        relation["kind"],
                        relation["input"]["name"],
                        relation["input"]["quantity_kind"],
                        relation["output"]["name"],
                        relation["output"]["quantity_kind"],
                        relation["minimum_samples"],
                        int(relation["shared_basis"]),
                    ),
                )
            for manifest in dataset["solverManifests"]:
                insert_solver_manifest(connection, manifest)
            for experiment in dataset.get("experiments", []):
                insert_experiment(connection, experiment)
            metadata = {
                "catalogRevision": "",
                "quantityKindDataVersion": dataset["quantityKindDataVersion"],
                "materialCatalogVersion": dataset["materialCatalogVersion"],
            }
            connection.executemany("INSERT INTO catalog_metadata VALUES (?, ?)", metadata.items())
        connection.execute("PRAGMA journal_mode = DELETE")
        connection.execute("VACUUM")
    finally:
        connection.close()
    refresh_derived_data(path)


def create_draft(destination: Path, source: Path) -> None:
    source_path = source.resolve()
    destination = destination.resolve()
    if not source_path.is_file():
        raise CatalogNotFoundError(f"Catalog SQLite file does not exist: {source_path}")
    if source_path == destination:
        raise CatalogError("Draft destination must differ from its source")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp.sqlite3")
    if temporary.exists():
        temporary.unlink()
    source_connection = sqlite3.connect(source_path)
    target_connection = sqlite3.connect(temporary)
    try:
        source_connection.backup(target_connection)
    finally:
        target_connection.close()
        source_connection.close()
    os.replace(temporary, destination)


def rebase_database(path: Path) -> None:
    source_path = path.resolve()
    if not source_path.is_file():
        raise CatalogNotFoundError(f"Catalog SQLite file does not exist: {source_path}")
    fd, temporary_name = tempfile.mkstemp(prefix="catalog-rebase-", suffix=".sqlite3", dir=source_path.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    temporary.unlink()
    source = sqlite3.connect(source_path)
    source.row_factory = sqlite3.Row
    target = sqlite3.connect(temporary)
    try:
        try:
            application_id = source.execute("PRAGMA application_id").fetchone()[0]
            if application_id != APPLICATION_ID:
                raise CatalogError(f"Unsupported catalog application_id: {application_id}")
            create_schema(target)
            source_tables = {
                row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            }
            with target:
                for table in TABLE_ORDER:
                    if table not in source_tables:
                        continue
                    source_columns = {row[1] for row in source.execute(f'PRAGMA table_info("{table}")')}
                    columns = [
                        row[1]
                        for row in target.execute(f'PRAGMA table_info("{table}")')
                        if row[1] in source_columns
                    ]
                    if not columns:
                        continue
                    names = ", ".join(f'"{column}"' for column in columns)
                    rows = source.execute(f'SELECT {names} FROM "{table}"').fetchall()
                    if rows:
                        placeholders = ", ".join("?" for _ in columns)
                        target.executemany(
                            f'INSERT INTO "{table}" ({names}) VALUES ({placeholders})',
                            rows,
                        )
            target.execute("PRAGMA journal_mode = DELETE")
            target.execute("VACUUM")
        finally:
            target.close()
            source.close()
        os.replace(temporary, source_path)
    finally:
        if temporary.exists():
            temporary.unlink()
    refresh_derived_data(source_path)


def publish_draft(source: Path, destination: Path) -> dict[str, Any]:
    source = source.resolve()
    destination_path = destination.resolve()
    refresh_derived_data(source)
    with Catalog.open_readonly(source, immutable=False) as catalog:
        meta = catalog.meta()
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix="catalog-", suffix=".sqlite3", dir=destination_path.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        shutil.copy2(source, temporary)
        try:
            os.replace(temporary, destination_path)
        except PermissionError:
            source_connection = sqlite3.connect(temporary)
            destination_connection = sqlite3.connect(destination_path)
            try:
                source_connection.backup(destination_connection)
            finally:
                destination_connection.close()
                source_connection.close()
    finally:
        if temporary.exists():
            temporary.unlink()
    return meta


def _rebuild_solver_usages(connection: sqlite3.Connection) -> None:
    connection.execute("DELETE FROM solver_quantity_kind_usages")
    solvers = connection.execute("SELECT name, version FROM solvers ORDER BY name, version").fetchall()
    for solver_row in solvers:
        solver = (solver_row["name"], solver_row["version"])
        ordinal = 0
        for row in connection.execute(
            "SELECT name, data_json FROM solver_parameters WHERE solver_name = ? AND solver_version = ? ORDER BY ordinal",
            solver,
        ):
            ordinal = _insert_data_usages(
                connection, solver, json.loads(row["data_json"]), "parameter", f"parameters.{row['name']}", ordinal
            )
        for row in connection.execute(
            """
            SELECT role, material_parameter, data_json FROM solver_material_properties
            WHERE solver_name = ? AND solver_version = ? ORDER BY role, ordinal
            """,
            solver,
        ):
            ordinal = _insert_data_usages(
                connection,
                solver,
                json.loads(row["data_json"]),
                "material",
                f"materials.{row['role']}.properties.{row['material_parameter']}",
                ordinal,
            )
        for row in connection.execute(
            "SELECT name, data_json FROM solver_input_ports WHERE solver_name = ? AND solver_version = ? ORDER BY ordinal",
            solver,
        ):
            ordinal = _insert_data_usages(
                connection, solver, json.loads(row["data_json"]), "input", f"inputPorts.{row['name']}.data", ordinal
            )
        for row in connection.execute(
            """
            SELECT category, method_id, name, data_json FROM solver_method_parameters
            WHERE solver_name = ? AND solver_version = ? ORDER BY category, method_id, ordinal
            """,
            solver,
        ):
            ordinal = _insert_data_usages(
                connection,
                solver,
                json.loads(row["data_json"]),
                "parameter",
                f"methods.{row['category']}.{row['method_id']}.parameters.{row['name']}",
                ordinal,
            )
        for row in connection.execute(
            """
            SELECT category, method_id, data_json FROM solver_methods
            WHERE solver_name = ? AND solver_version = ? AND data_json IS NOT NULL ORDER BY category, ordinal
            """,
            solver,
        ):
            ordinal = _insert_data_usages(
                connection,
                solver,
                json.loads(row["data_json"]),
                "output",
                f"methods.{row['category']}.{row['method_id']}.data",
                ordinal,
            )


def _rebuild_artifact_types(connection: sqlite3.Connection) -> None:
    contracts: dict[str, str] = {}
    rows = connection.execute(
        """SELECT artifact_type, data_json FROM solver_methods
           WHERE category = 'outputs' AND artifact_type IS NOT NULL AND data_json IS NOT NULL
           UNION ALL
           SELECT a.artifact_type, p.data_json
           FROM solver_input_artifact_types AS a
           JOIN solver_input_ports AS p
             ON p.solver_name = a.solver_name
            AND p.solver_version = a.solver_version
            AND p.name = a.input_port
           ORDER BY artifact_type"""
    ).fetchall()
    for row in rows:
        data_json = canonical_json(json.loads(row["data_json"]))
        previous = contracts.setdefault(row["artifact_type"], data_json)
        if previous != data_json:
            raise CatalogError(f"Artifact type {row['artifact_type']} has conflicting data contracts")
    connection.execute("DELETE FROM artifact_types")
    connection.executemany(
        "INSERT INTO artifact_types(name, payload_kind, data_json) VALUES (?, ?, ?)",
        [
            (
                name,
                "structured-bundle"
                if json.loads(data_json).get("resourceKind") == "structuredBundle"
                else "field"
                if json.loads(data_json).get("axes")
                else "scalar",
                data_json,
            )
            for name, data_json in sorted(contracts.items())
        ],
    )


def _revision_payload(path: Path) -> dict[str, Any]:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        tables: dict[str, list[dict[str, Any]]] = {}
        for table in TABLE_ORDER:
            info = connection.execute(f'PRAGMA table_info("{table}")').fetchall()
            columns = [row["name"] for row in info]
            primary_key = [
                row["name"] for row in sorted((row for row in info if row["pk"]), key=lambda row: row["pk"])
            ]
            names = ", ".join(f'"{column}"' for column in columns)
            where = " WHERE key != 'catalogRevision'" if table == "catalog_metadata" else ""
            order = f" ORDER BY {', '.join(primary_key)}" if primary_key else ""
            tables[table] = [
                dict(row)
                for row in connection.execute(f'SELECT {names} FROM "{table}"{where}{order}')
            ]
        return {"tables": tables}
    finally:
        connection.close()


def _refresh_experiment_hashes(connection: sqlite3.Connection) -> None:
    for experiment in connection.execute("SELECT id FROM experiments ORDER BY id"):
        files = {
            row["path"]: row["source"]
            for row in connection.execute(
                "SELECT path, source FROM experiment_files WHERE experiment_id = ? ORDER BY ordinal",
                (experiment["id"],),
            )
        }
        bundle_hash = hashlib.sha256(canonical_json({"files": files}).encode("utf-8")).hexdigest()
        connection.execute(
            "UPDATE experiments SET bundle_hash = ? WHERE id = ?",
            (bundle_hash, experiment["id"]),
        )


def refresh_derived_data(path: Path) -> None:
    with writable_connection(path) as connection:
        _rebuild_solver_usages(connection)
        _rebuild_artifact_types(connection)
        _refresh_experiment_hashes(connection)
    payload = _revision_payload(path)
    revision = hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()
    with writable_connection(path) as connection:
        connection.execute(
            "INSERT INTO catalog_metadata(key, value) VALUES ('catalogRevision', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (revision,),
        )


@contextmanager
def writable_connection(path: Path) -> Iterable[sqlite3.Connection]:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()
