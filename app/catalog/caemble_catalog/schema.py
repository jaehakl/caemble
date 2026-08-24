from __future__ import annotations

import hashlib
import json
import sqlite3

APPLICATION_ID = 0x4341454D  # "CAEM"
SCHEMA_VERSION = 5
RUNTIME_SLICE_SCHEMA_VERSION = 1
SEMVER_COMPONENT_MAX = 2_147_483_647
EXPERIMENT_COORDINATE_PREFIX = "caemble:experiment/"


def parse_experiment_version(value: str) -> tuple[int, int, int]:
    parts = value.split(".")
    if (
        len(parts) != 3
        or any(not part.isascii() or not part.isdigit() or (len(part) > 1 and part.startswith("0")) for part in parts)
    ):
        raise ValueError("Experiment version must be a release-only three-part SemVer")
    values = tuple(int(part) for part in parts)
    if any(part > SEMVER_COMPONENT_MAX for part in values):
        raise ValueError(f"Experiment SemVer components must not exceed {SEMVER_COMPONENT_MAX}")
    return values  # type: ignore[return-value]


def parse_experiment_coordinate(value: str) -> tuple[str, str, str, str]:
    if not value.startswith(EXPERIMENT_COORDINATE_PREFIX):
        raise ValueError("Experiment coordinate must start with caemble:experiment/")
    path, separator, version = value[len(EXPERIMENT_COORDINATE_PREFIX) :].rpartition("@")
    parts = path.split("/")
    if not separator or len(parts) != 3 or any(not part for part in parts):
        raise ValueError("Experiment coordinate must use namespace/repository/key@version")
    parse_experiment_version(version)
    return parts[0], parts[1], parts[2], version

CATALOG_ENTITY_SCHEMA_SQL = r"""
CREATE TABLE experiments (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL,
    namespace TEXT NOT NULL,
    repository_slug TEXT NOT NULL,
    version_major INTEGER NOT NULL CHECK (version_major BETWEEN 0 AND 2147483647),
    version_minor INTEGER NOT NULL CHECK (version_minor BETWEEN 0 AND 2147483647),
    version_patch INTEGER NOT NULL CHECK (version_patch BETWEEN 0 AND 2147483647),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    cad_api_version INTEGER NOT NULL CHECK (cad_api_version = 9),
    source_format_version INTEGER NOT NULL CHECK (source_format_version = 2),
    bundle_format_version INTEGER NOT NULL CHECK (bundle_format_version = 6),
    verification_json TEXT NOT NULL CHECK (json_valid(verification_json)),
    bundle_hash TEXT NOT NULL CHECK (length(bundle_hash) = 64),
    UNIQUE (namespace, repository_slug, key, version_major, version_minor, version_patch)
) STRICT;

CREATE TABLE experiment_files (
    experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    path TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (experiment_id, path),
    UNIQUE (experiment_id, ordinal)
) STRICT;

CREATE TABLE experiment_concepts (
    experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    concept TEXT NOT NULL,
    PRIMARY KEY (experiment_id, ordinal),
    UNIQUE (experiment_id, concept)
) STRICT;

CREATE TABLE experiment_solvers (
    experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    PRIMARY KEY (experiment_id, solver_name, solver_version),
    UNIQUE (experiment_id, ordinal),
    FOREIGN KEY (solver_name, solver_version) REFERENCES solvers(name, version)
) STRICT;

CREATE INDEX experiment_solvers_solver_idx
ON experiment_solvers(solver_name, solver_version, experiment_id);

CREATE INDEX experiments_key_idx ON experiments(key);
"""

SCHEMA_SQL = r"""
PRAGMA foreign_keys = ON;

CREATE TABLE catalog_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE quantity_kinds (
    name TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    tensor_order INTEGER NOT NULL CHECK (tensor_order >= 0),
    description TEXT,
    opaque INTEGER NOT NULL DEFAULT 0 CHECK (opaque IN (0, 1))
) STRICT;

CREATE TABLE quantity_kind_units (
    quantity_kind TEXT NOT NULL REFERENCES quantity_kinds(name) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    unit TEXT NOT NULL,
    PRIMARY KEY (quantity_kind, ordinal),
    UNIQUE (quantity_kind, unit)
) STRICT;

CREATE TABLE material_parameters (
    key TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    label_ko TEXT NOT NULL,
    quantity_kind TEXT NOT NULL REFERENCES quantity_kinds(name)
) STRICT;

CREATE TABLE material_parameter_qualifiers (
    material_parameter TEXT NOT NULL REFERENCES material_parameters(key) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    qualifier TEXT NOT NULL,
    PRIMARY KEY (material_parameter, ordinal),
    UNIQUE (material_parameter, qualifier)
) STRICT;

CREATE TABLE material_global_qualifiers (
    ordinal INTEGER PRIMARY KEY CHECK (ordinal >= 0),
    qualifier TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE material_design_rules (
    key TEXT PRIMARY KEY,
    description TEXT NOT NULL
) STRICT;

CREATE TABLE material_models (
    key TEXT PRIMARY KEY,
    label_ko TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind = 'sampled_relation'),
    input_name TEXT NOT NULL,
    input_quantity_kind TEXT NOT NULL REFERENCES quantity_kinds(name),
    output_name TEXT NOT NULL,
    output_quantity_kind TEXT NOT NULL REFERENCES quantity_kinds(name),
    minimum_samples INTEGER NOT NULL CHECK (minimum_samples >= 2),
    shared_basis INTEGER NOT NULL CHECK (shared_basis IN (0, 1))
) STRICT;

CREATE TABLE solvers (
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    implementation TEXT NOT NULL,
    description TEXT NOT NULL,
    reference_length_unit TEXT NOT NULL,
    minimum_outputs INTEGER NOT NULL CHECK (minimum_outputs >= 0),
    contract_digest TEXT NOT NULL CHECK (length(contract_digest) = 64),
    PRIMARY KEY (name, version),
    UNIQUE (name)
) STRICT;

CREATE TABLE solver_parameters (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    PRIMARY KEY (solver_name, solver_version, name),
    UNIQUE (solver_name, solver_version, ordinal),
    FOREIGN KEY (solver_name, solver_version) REFERENCES solvers(name, version) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_material_roles (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    role TEXT NOT NULL,
    description TEXT NOT NULL,
    target_category TEXT NOT NULL,
    target_method_id TEXT NOT NULL,
    PRIMARY KEY (solver_name, solver_version, role),
    UNIQUE (solver_name, solver_version, ordinal),
    FOREIGN KEY (solver_name, solver_version) REFERENCES solvers(name, version) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_material_properties (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    role TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    material_parameter TEXT NOT NULL REFERENCES material_parameters(key),
    description TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    PRIMARY KEY (solver_name, solver_version, role, material_parameter),
    UNIQUE (solver_name, solver_version, role, ordinal),
    FOREIGN KEY (solver_name, solver_version, role)
      REFERENCES solver_material_roles(solver_name, solver_version, role) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_input_ports (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    minimum_occurrences INTEGER NOT NULL CHECK (minimum_occurrences >= 0),
    maximum_occurrences INTEGER NOT NULL CHECK (maximum_occurrences >= minimum_occurrences),
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    PRIMARY KEY (solver_name, solver_version, name),
    UNIQUE (solver_name, solver_version, ordinal),
    FOREIGN KEY (solver_name, solver_version) REFERENCES solvers(name, version) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_input_artifact_types (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    input_port TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    artifact_type TEXT NOT NULL,
    PRIMARY KEY (solver_name, solver_version, input_port, ordinal),
    UNIQUE (solver_name, solver_version, input_port, artifact_type),
    FOREIGN KEY (solver_name, solver_version, input_port)
      REFERENCES solver_input_ports(solver_name, solver_version, name) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_observations (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    type TEXT NOT NULL,
    PRIMARY KEY (solver_name, solver_version, name),
    UNIQUE (solver_name, solver_version, ordinal),
    FOREIGN KEY (solver_name, solver_version) REFERENCES solvers(name, version) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_methods (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('initializations', 'boundaryConditions', 'outputs')),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    method_id TEXT NOT NULL,
    description TEXT NOT NULL,
    minimum_occurrences INTEGER NOT NULL CHECK (minimum_occurrences >= 0),
    maximum_occurrences INTEGER NOT NULL CHECK (maximum_occurrences >= minimum_occurrences),
    target_source TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    minimum_targets INTEGER NOT NULL CHECK (minimum_targets >= 0),
    maximum_targets INTEGER NOT NULL CHECK (maximum_targets >= minimum_targets),
    minimum_resolved INTEGER NOT NULL CHECK (minimum_resolved >= 0),
    maximum_resolved INTEGER NOT NULL CHECK (maximum_resolved >= minimum_resolved),
    artifact_type TEXT,
    data_json TEXT CHECK (data_json IS NULL OR json_valid(data_json)),
    PRIMARY KEY (solver_name, solver_version, category, method_id),
    UNIQUE (solver_name, solver_version, category, ordinal),
    FOREIGN KEY (solver_name, solver_version) REFERENCES solvers(name, version) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_method_parameters (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    category TEXT NOT NULL,
    method_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    PRIMARY KEY (solver_name, solver_version, category, method_id, name),
    UNIQUE (solver_name, solver_version, category, method_id, ordinal),
    FOREIGN KEY (solver_name, solver_version, category, method_id)
      REFERENCES solver_methods(solver_name, solver_version, category, method_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_quantity_kind_usages (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    quantity_kind TEXT NOT NULL REFERENCES quantity_kinds(name),
    context TEXT NOT NULL CHECK (context IN ('parameter', 'material', 'input', 'output', 'axis')),
    path TEXT NOT NULL,
    unit TEXT,
    PRIMARY KEY (solver_name, solver_version, ordinal),
    UNIQUE (solver_name, solver_version, context, path),
    FOREIGN KEY (solver_name, solver_version) REFERENCES solvers(name, version) ON DELETE CASCADE
) STRICT;

CREATE VIEW solver_material_requirements AS
SELECT p.solver_name, p.solver_version, p.role, r.description AS role_description,
       r.target_category, r.target_method_id, p.material_parameter,
       p.description, json_extract(p.data_json, '$.quantityKind') AS quantity_kind,
       json_extract(p.data_json, '$.unit') AS unit
FROM solver_material_properties AS p
JOIN solver_material_roles AS r
  ON r.solver_name = p.solver_name AND r.solver_version = p.solver_version AND r.role = p.role;

CREATE VIEW quantity_kind_solver_usages AS
SELECT u.quantity_kind, u.solver_name, u.solver_version, u.context, u.path, u.unit
FROM solver_quantity_kind_usages AS u;

CREATE VIEW solver_artifact_compatibility AS
SELECT producer.solver_name AS producer_solver_name,
       producer.solver_version AS producer_solver_version,
       producer.method_id AS producer_method_id,
       producer.artifact_type,
       consumer.solver_name AS consumer_solver_name,
       consumer.solver_version AS consumer_solver_version,
       consumer.input_port AS consumer_input_port
FROM solver_methods AS producer
JOIN solver_input_artifact_types AS consumer ON consumer.artifact_type = producer.artifact_type
WHERE producer.category = 'outputs' AND producer.artifact_type IS NOT NULL;
""" + CATALOG_ENTITY_SCHEMA_SQL


def create_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(SCHEMA_SQL)
    connection.execute(f"PRAGMA application_id = {APPLICATION_ID}")
    connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def upgrade_schema(connection: sqlite3.Connection) -> None:
    application_id = connection.execute("PRAGMA application_id").fetchone()[0]
    user_version = connection.execute("PRAGMA user_version").fetchone()[0]
    if application_id != APPLICATION_ID:
        raise ValueError(
            f"Only a CAEM catalog database can be upgraded: "
            f"application_id={application_id}, user_version={user_version}"
        )
    if user_version == SCHEMA_VERSION:
        return
    if user_version == 4:
        connection.executescript(
            """
            ALTER TABLE experiment_solvers RENAME TO experiment_solvers_v4;
            ALTER TABLE experiment_concepts RENAME TO experiment_concepts_v4;
            ALTER TABLE experiment_files RENAME TO experiment_files_v4;
            ALTER TABLE experiments RENAME TO experiments_v4;
            DROP INDEX experiment_solvers_solver_idx;
            DROP INDEX experiments_key_idx;
            """
        )
        connection.executescript(CATALOG_ENTITY_SCHEMA_SQL)
        connection.execute(
            """INSERT INTO experiments(
                   id, key, namespace, repository_slug, version_major, version_minor, version_patch,
                   title, description, cad_api_version, source_format_version, bundle_format_version,
                   verification_json, bundle_hash
               )
               SELECT id, key, namespace, repository_slug, version_major, version_minor, version_patch,
                      title, description, 9, source_format_version, bundle_format_version,
                      verification_json, bundle_hash
               FROM experiments_v4"""
        )
        connection.execute(
            """INSERT INTO experiment_files(experiment_id, ordinal, path, source)
               SELECT experiment_id, ordinal, path, source FROM experiment_files_v4"""
        )
        connection.execute(
            """INSERT INTO experiment_concepts(experiment_id, ordinal, concept)
               SELECT experiment_id, ordinal, concept FROM experiment_concepts_v4"""
        )
        connection.execute(
            """INSERT INTO experiment_solvers(experiment_id, ordinal, solver_name, solver_version)
               SELECT experiment_id, ordinal, solver_name, solver_version FROM experiment_solvers_v4"""
        )
        connection.executescript(
            """
            DROP TABLE experiment_solvers_v4;
            DROP TABLE experiment_concepts_v4;
            DROP TABLE experiment_files_v4;
            DROP TABLE experiments_v4;
            """
        )
        connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        return
    if user_version != 3:
        raise ValueError(
            f"Only a CAEM catalog schema v3 or v4 database can be upgraded: "
            f"application_id={application_id}, user_version={user_version}"
        )
    connection.row_factory = sqlite3.Row
    experiments = []
    for row in connection.execute("SELECT * FROM experiments ORDER BY key"):
        files = {
            item["path"]: item["source"]
            for item in connection.execute(
                "SELECT path, source FROM experiment_files WHERE experiment_key = ? ORDER BY ordinal", (row["key"],)
            )
        }
        concepts = [
            item["concept"]
            for item in connection.execute(
                "SELECT concept FROM experiment_concepts WHERE experiment_key = ? ORDER BY ordinal", (row["key"],)
            )
        ]
        solvers = [
            (item["solver_name"], item["solver_version"])
            for item in connection.execute(
                "SELECT solver_name, solver_version FROM experiment_solvers WHERE experiment_key = ? ORDER BY ordinal",
                (row["key"],),
            )
        ]
        experiments.append(
            {
                "key": row["key"],
                "namespace": "caemble",
                "repository": "verified",
                "title": row["title"],
                "description": row["description"],
                "cad_api_version": 9,
                "source_format_version": row["source_format_version"],
                "verification": row["verification_json"],
                "files": files,
                "concepts": concepts,
                "solvers": solvers,
            }
        )
    for row in connection.execute("SELECT * FROM geometries ORDER BY key"):
        concepts = [
            item["concept"]
            for item in connection.execute(
                "SELECT concept FROM geometry_concepts WHERE geometry_key = ? ORDER BY ordinal", (row["key"],)
            )
        ]
        experiment_source = (
            "import { experiment } from '@caemble/core'\n"
            f"import {{ {row['export_name']} }} from './geometry'\n\n"
            "export default experiment({\n"
            f"  lengthUnit: {json.dumps(row['length_unit'])},\n"
            "  varsSchema: {},\n"
            f"  geometry: () => <{row['export_name']} id=\"catalog-preview\" />,\n"
            "  recordedData: {},\n"
            "})\n"
        )
        experiments.append(
            {
                "key": row["key"],
                "namespace": "caemble",
                "repository": row["repository_slug"],
                "title": row["title"],
                "description": row["description"],
                "cad_api_version": 9,
                "source_format_version": 2,
                "verification": json.dumps(
                    {"kernelTasks": [], "recordedData": [], "expectations": []},
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                "files": {
                    "experiment.tsx": experiment_source,
                    "geometry.tsx": row["source"],
                    "material.tsx": "export {}\n",
                    "simulate.py": "async def simulate(*, sim, tasks, vars):\n    return None\n",
                },
                "concepts": concepts,
                "solvers": [],
            }
        )
    connection.executescript(
        """
        DROP TABLE experiment_solvers;
        DROP TABLE experiment_concepts;
        DROP TABLE experiment_files;
        DROP TABLE experiments;
        DROP TABLE geometry_elements;
        DROP TABLE geometry_material_roles;
        DROP TABLE geometry_concepts;
        DROP TABLE geometries;
        DROP TABLE geometry_repositories;
        """
    )
    connection.executescript(CATALOG_ENTITY_SCHEMA_SQL)
    for experiment in experiments:
        bundle = {"formatVersion": 6, "files": experiment["files"]}
        cursor = connection.execute(
            """INSERT INTO experiments(
                   key, namespace, repository_slug, version_major, version_minor, version_patch,
                   title, description, cad_api_version, source_format_version, bundle_format_version,
                   verification_json, bundle_hash
               ) VALUES (?, ?, ?, 1, 0, 0, ?, ?, ?, ?, 6, ?, ?)""",
            (
                experiment["key"],
                experiment["namespace"],
                experiment["repository"],
                experiment["title"],
                experiment["description"],
                experiment["cad_api_version"],
                experiment["source_format_version"],
                experiment["verification"],
                hashlib.sha256(
                    json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
                ).hexdigest(),
            ),
        )
        experiment_id = cursor.lastrowid
        connection.executemany(
            "INSERT INTO experiment_files(experiment_id, ordinal, path, source) VALUES (?, ?, ?, ?)",
            [
                (experiment_id, ordinal, path, source)
                for ordinal, (path, source) in enumerate(sorted(experiment["files"].items()))
            ],
        )
        connection.executemany(
            "INSERT INTO experiment_concepts(experiment_id, ordinal, concept) VALUES (?, ?, ?)",
            [(experiment_id, ordinal, concept) for ordinal, concept in enumerate(experiment["concepts"])],
        )
        connection.executemany(
            """INSERT INTO experiment_solvers(
                   experiment_id, ordinal, solver_name, solver_version
               ) VALUES (?, ?, ?, ?)""",
            [
                (experiment_id, ordinal, name, version)
                for ordinal, (name, version) in enumerate(experiment["solvers"])
            ],
        )
    connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
