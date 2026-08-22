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

from .database import Catalog, catalog_path
from .errors import CatalogError, CatalogIntegrityError, CatalogNotFoundError
from .schema import create_schema, parse_experiment_version, upgrade_schema
from .validation import validate_catalog_content


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def contract_digest(catalog: Catalog, manifest: dict[str, Any]) -> str:
    descriptor = manifest["descriptor"]
    solver = (descriptor["name"], descriptor["version"])
    material_keys = [
        row["material_parameter"]
        for row in catalog._all(
            """
            SELECT DISTINCT material_parameter FROM solver_material_properties
            WHERE solver_name = ? AND solver_version = ? ORDER BY material_parameter
            """,
            solver,
        )
    ]
    materials = [catalog.material_parameter(key) for key in material_keys]
    quantity_names = {
        row["quantity_kind"]
        for row in catalog._all(
            """
            SELECT DISTINCT quantity_kind FROM solver_quantity_kind_usages
            WHERE solver_name = ? AND solver_version = ?
            """,
            solver,
        )
    }
    quantity_names.update(item["quantityKind"] for item in materials)
    payload = {
        "manifest": manifest,
        "quantityKinds": [catalog.quantity_kind(name) for name in sorted(quantity_names)],
        "materialParameters": materials,
        "materialModels": [],
    }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


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
    digest = "0" * 64
    connection.execute(
        "INSERT INTO solvers VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            *solver,
            manifest["schemaVersion"],
            manifest["implementation"],
            descriptor["description"],
            descriptor["referenceLengthUnit"],
            descriptor["minimumOutputs"],
            digest,
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
               title, description, cad_api_version, source_format_version, bundle_format_version,
               verification_json, bundle_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            experiment["key"],
            experiment.get("namespace", "caemble"),
            experiment.get("repository", "verified"),
            *version,
            experiment["title"],
            experiment["description"],
            experiment.get("cadApiVersion", 8),
            experiment.get("sourceFormatVersion", 2),
            bundle["formatVersion"],
            canonical_json(experiment["verification"]),
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
    if dataset.get("geometryRepositories") or dataset.get("geometries"):
        raise CatalogError("Geometry catalog rows are no longer supported; convert them to Experiment bundles")
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
            revision_source = {
                "quantityKinds": quantity_kinds,
                "opaqueQuantityKindNames": sorted(opaque_names),
                "materialParameters": dataset["materialParameters"],
                "materialModels": dataset["materialModels"],
                "materialGlobalQualifiers": dataset["materialGlobalQualifiers"],
                "materialDesignRules": dataset["materialDesignRules"],
                "solverManifests": dataset["solverManifests"],
            }
            revision = hashlib.sha256(canonical_json(revision_source).encode("utf-8")).hexdigest()
            metadata = {
                "catalogRevision": revision,
                "quantityKindDataVersion": dataset["quantityKindDataVersion"],
                "materialCatalogVersion": dataset["materialCatalogVersion"],
            }
            connection.executemany("INSERT INTO catalog_metadata VALUES (?, ?)", metadata.items())
        connection.execute("PRAGMA journal_mode = DELETE")
        connection.execute("VACUUM")
    finally:
        connection.close()
    refresh_derived_data(path)
    validate_database(path)


def validate_database(path: Path) -> dict[str, Any]:
    with Catalog.open_readonly(path, immutable=False) as catalog:
        validate_catalog_content(catalog)
        manifests = catalog.solver_manifests()
        for manifest in manifests:
            descriptor = manifest["descriptor"]
            stored = catalog.solver_contract_digest(descriptor["name"], descriptor["version"])
            if stored != contract_digest(catalog, manifest):
                raise CatalogIntegrityError(f"Contract digest mismatch: {descriptor['name']}@{descriptor['version']}")
        for usage in catalog._all(
            """
            SELECT u.solver_name, u.solver_version, u.path, u.quantity_kind, u.unit, q.opaque
            FROM solver_quantity_kind_usages u JOIN quantity_kinds q ON q.name = u.quantity_kind
            """
        ):
            if usage["opaque"]:
                raise CatalogIntegrityError(
                    f"{usage['solver_name']}@{usage['solver_version']} {usage['path']} uses opaque "
                    f"QuantityKind {usage['quantity_kind']}"
                )
            if usage["unit"] is None:
                raise CatalogIntegrityError(
                    f"{usage['solver_name']}@{usage['solver_version']} {usage['path']} has no unit"
                )
            known = catalog._one(
                "SELECT 1 FROM quantity_kind_units WHERE quantity_kind = ? AND unit = ?",
                (usage["quantity_kind"], usage["unit"]),
            )
            if known is None:
                raise CatalogIntegrityError(
                    f"{usage['solver_name']}@{usage['solver_version']} {usage['path']} uses unit "
                    f"{usage['unit']} outside QuantityKind {usage['quantity_kind']}"
                )
        for solver in catalog._all("SELECT name, version, reference_length_unit FROM solvers"):
            known = catalog._one(
                "SELECT 1 FROM quantity_kind_units WHERE quantity_kind = 'Length' AND unit = ?",
                (solver["reference_length_unit"],),
            )
            if known is None:
                raise CatalogIntegrityError(
                    f"{solver['name']}@{solver['version']} referenceLengthUnit "
                    f"{solver['reference_length_unit']!r} is not applicable to Length"
                )
        mismatches = catalog._all(
            """
            SELECT p.solver_name, p.solver_version, p.role, p.material_parameter,
                   m.quantity_kind AS expected, json_extract(p.data_json, '$.quantityKind') AS actual
            FROM solver_material_properties p
            JOIN material_parameters m ON m.key = p.material_parameter
            WHERE json_extract(p.data_json, '$.quantityKind') IS NOT m.quantity_kind
            """
        )
        if mismatches:
            mismatch = mismatches[0]
            raise CatalogIntegrityError(
                f"{mismatch['solver_name']}@{mismatch['solver_version']} material role {mismatch['role']} "
                f"uses {mismatch['material_parameter']} as {mismatch['actual']!r}; expected {mismatch['expected']!r}"
            )
        return catalog.meta()


def draft_path(root: Path | None = None) -> Path:
    workspace = root or Path.cwd()
    return workspace / ".catalog-work" / "draft.sqlite3"


def upgrade_database(path: Path) -> None:
    with writable_connection(path) as connection:
        upgrade_schema(connection)
    refresh_derived_data(path)
    validate_database(path)
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA journal_mode = DELETE")
        connection.execute("VACUUM")
    finally:
        connection.close()


def create_draft(destination: Path, source: Path | None = None) -> None:
    source_path = (source or catalog_path()).resolve()
    if not source_path.is_file():
        raise CatalogNotFoundError(f"Catalog SQLite file does not exist: {source_path}")
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


def publish_draft(source: Path, destination: Path | None = None) -> dict[str, Any]:
    destination_path = (destination or catalog_path()).resolve()
    refresh_derived_data(source)
    meta = validate_database(source)
    if destination_path.is_file():
        baseline = semantic_snapshot(destination_path)["solvers"]
        candidate = semantic_snapshot(source)["solvers"]
        with Catalog.open_readonly(destination_path, immutable=False) as catalog:
            baseline_contracts = catalog.solver_contracts()
        with Catalog.open_readonly(source, immutable=False) as catalog:
            candidate_contracts = catalog.solver_contracts()
        for identity in baseline.keys() & candidate.keys():
            name, version = identity.rsplit("@", 1)
            if baseline[identity] != candidate[identity] or baseline_contracts[(name, version)] != candidate_contracts[
                (name, version)
            ]:
                raise CatalogIntegrityError(
                    f"Released Solver contract {identity} is immutable; replace it with a new version"
                )
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix="catalog-", suffix=".sqlite3", dir=destination_path.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        shutil.copy2(source, temporary)
        validate_database(temporary)
        os.replace(temporary, destination_path)
    finally:
        if temporary.exists():
            temporary.unlink()
    return meta


def semantic_snapshot(path: Path) -> dict[str, Any]:
    with Catalog.open_readonly(path, immutable=False) as catalog:
        return {
            "meta": catalog.meta(),
            "quantityKinds": {
                row["name"]: catalog.quantity_kind(row["name"])
                for row in catalog._all("SELECT name FROM quantity_kinds ORDER BY name")
            },
            "materialParameters": {
                row["key"]: catalog.material_parameter(row["key"])
                for row in catalog._all("SELECT key FROM material_parameters ORDER BY key")
            },
            "materialModels": {item["key"]: item for item in catalog.material_models()},
            "solvers": {
                f"{item['descriptor']['name']}@{item['descriptor']['version']}": item
                for item in catalog.solver_manifests()
            },
            "experiments": {
                item["coordinate"]: catalog.experiment(
                    item["key"],
                    namespace=item["namespace"],
                    repository=item["repository"],
                    version=item["version"],
                )
                for item in catalog.list_experiments(limit=10_000)[0]
            },
        }


def semantic_diff(candidate: Path, baseline: Path | None = None) -> list[str]:
    before = semantic_snapshot((baseline or catalog_path()).resolve())
    after = semantic_snapshot(candidate.resolve())
    changes: list[str] = []
    for section in (
        "quantityKinds",
        "materialParameters",
        "materialModels",
        "solvers",
        "experiments",
    ):
        before_items = before[section]
        after_items = after[section]
        for key in sorted(before_items.keys() - after_items.keys()):
            changes.append(f"- {section}/{key}")
        for key in sorted(after_items.keys() - before_items.keys()):
            changes.append(f"+ {section}/{key}")
        for key in sorted(before_items.keys() & after_items.keys()):
            if before_items[key] != after_items[key]:
                changes.append(f"~ {section}/{key}")
    return changes


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


def _revision_payload(path: Path) -> dict[str, Any]:
    with Catalog.open_readonly(path, immutable=False) as catalog:
        meta = catalog.meta()
        return {
            "catalogVersions": {
                "quantityKindDataVersion": meta["quantityKindDataVersion"],
                "materialCatalogVersion": meta["materialCatalogVersion"],
            },
            "quantityKinds": {
                row["name"]: catalog.quantity_kind(row["name"])
                for row in catalog._all("SELECT name FROM quantity_kinds ORDER BY name")
            },
            "materialParameters": {
                row["key"]: catalog.material_parameter(row["key"])
                for row in catalog._all("SELECT key FROM material_parameters ORDER BY key")
            },
            "materialModels": catalog.material_models(),
            "materialGlobalQualifiers": [
                row["qualifier"] for row in catalog._all("SELECT qualifier FROM material_global_qualifiers ORDER BY ordinal")
            ],
            "materialDesignRules": {
                row["key"]: row["description"]
                for row in catalog._all("SELECT key, description FROM material_design_rules ORDER BY key")
            },
            "solverManifests": catalog.solver_manifests(),
            "experiments": [
                catalog.experiment(
                    item["key"],
                    namespace=item["namespace"],
                    repository=item["repository"],
                    version=item["version"],
                )
                for item in catalog.list_experiments(limit=10_000)[0]
            ],
        }


def refresh_derived_data(path: Path) -> None:
    with writable_connection(path) as connection:
        _rebuild_solver_usages(connection)
    payload = _revision_payload(path)
    manifests = payload["solverManifests"]
    revision = hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()
    with Catalog.open_readonly(path, immutable=False) as catalog:
        digests = [
            (
                contract_digest(catalog, manifest),
                manifest["descriptor"]["name"],
                manifest["descriptor"]["version"],
            )
            for manifest in manifests
        ]
    with writable_connection(path) as connection:
        connection.executemany(
            "UPDATE solvers SET contract_digest = ? WHERE name = ? AND version = ?",
            digests,
        )
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
