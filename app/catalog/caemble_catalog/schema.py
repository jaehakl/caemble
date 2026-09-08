from __future__ import annotations

import sqlite3

APPLICATION_ID = 0x43414531  # "CAE1"
SCHEMA_VERSION = 3
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


TABLE_ORDER = (
    "catalog_metadata",
    "quantity_kinds",
    "quantity_kind_units",
    "material_models",
    "material_model_quantity_kind_usages",
    "artifact_types",
    "solvers",
    "solver_parameters",
    "solver_material_roles",
    "solver_material_model_groups",
    "solver_material_model_options",
    "solver_input_ports",
    "solver_input_artifact_types",
    "solver_observations",
    "solver_methods",
    "solver_method_parameters",
    "solver_quantity_kind_usages",
    "experiments",
    "experiment_files",
    "experiment_concepts",
    "experiment_solvers",
)


SCHEMA_SQL = r"""
PRAGMA foreign_keys = ON;

CREATE TABLE catalog_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE quantity_kinds (
    name TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    tensor_order INTEGER NOT NULL,
    description TEXT,
    opaque INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE quantity_kind_units (
    quantity_kind TEXT NOT NULL REFERENCES quantity_kinds(name) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    unit TEXT NOT NULL,
    PRIMARY KEY (quantity_kind, ordinal),
    UNIQUE (quantity_kind, unit)
) STRICT;

CREATE TABLE material_models (
    key TEXT PRIMARY KEY,
    label_ko TEXT NOT NULL,
    description TEXT NOT NULL,
    equation TEXT NOT NULL,
    conventions TEXT NOT NULL,
    parameter_schema_json TEXT NOT NULL CHECK(json_valid(parameter_schema_json))
) STRICT;

CREATE TABLE material_model_quantity_kind_usages (
    model_key TEXT NOT NULL REFERENCES material_models(key) ON DELETE CASCADE,
    path TEXT NOT NULL,
    quantity_kind TEXT NOT NULL REFERENCES quantity_kinds(name),
    unit TEXT,
    PRIMARY KEY (model_key, path)
) STRICT;

CREATE TABLE solvers (
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    implementation TEXT NOT NULL,
    implementation_abi INTEGER NOT NULL DEFAULT 1 CHECK (implementation_abi >= 1),
    description TEXT NOT NULL,
    reference_length_unit TEXT NOT NULL,
    minimum_outputs INTEGER NOT NULL,
    PRIMARY KEY (name, version)
) STRICT;

CREATE TABLE artifact_types (
    name TEXT PRIMARY KEY,
    payload_kind TEXT NOT NULL,
    data_json TEXT NOT NULL
) STRICT;

CREATE TABLE solver_parameters (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (solver_name, solver_version, name),
    UNIQUE (solver_name, solver_version, ordinal),
    FOREIGN KEY (solver_name, solver_version) REFERENCES solvers(name, version) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_material_roles (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    role TEXT NOT NULL,
    description TEXT NOT NULL,
    target_category TEXT NOT NULL,
    target_method_id TEXT NOT NULL,
    PRIMARY KEY (solver_name, solver_version, role),
    UNIQUE (solver_name, solver_version, ordinal),
    FOREIGN KEY (solver_name, solver_version) REFERENCES solvers(name, version) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_material_model_groups (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    role TEXT NOT NULL,
    key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    required INTEGER NOT NULL CHECK(required IN (0, 1)),
    PRIMARY KEY (solver_name, solver_version, role, key),
    UNIQUE (solver_name, solver_version, role, ordinal),
    FOREIGN KEY (solver_name, solver_version, role)
      REFERENCES solver_material_roles(solver_name, solver_version, role) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_material_model_options (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    role TEXT NOT NULL,
    group_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    model_key TEXT NOT NULL REFERENCES material_models(key),
    PRIMARY KEY (solver_name, solver_version, role, group_key, model_key),
    UNIQUE (solver_name, solver_version, role, group_key, ordinal),
    FOREIGN KEY (solver_name, solver_version, role, group_key)
      REFERENCES solver_material_model_groups(solver_name, solver_version, role, key) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_input_ports (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    minimum_occurrences INTEGER NOT NULL,
    maximum_occurrences INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (solver_name, solver_version, name),
    UNIQUE (solver_name, solver_version, ordinal),
    FOREIGN KEY (solver_name, solver_version) REFERENCES solvers(name, version) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_input_artifact_types (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    input_port TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    artifact_type TEXT NOT NULL,
    PRIMARY KEY (solver_name, solver_version, input_port, ordinal),
    UNIQUE (solver_name, solver_version, input_port, artifact_type),
    FOREIGN KEY (solver_name, solver_version, input_port)
      REFERENCES solver_input_ports(solver_name, solver_version, name) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_observations (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
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
    category TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    method_id TEXT NOT NULL,
    description TEXT NOT NULL,
    minimum_occurrences INTEGER NOT NULL,
    maximum_occurrences INTEGER NOT NULL,
    target_source TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    minimum_targets INTEGER NOT NULL,
    maximum_targets INTEGER NOT NULL,
    minimum_resolved INTEGER NOT NULL,
    maximum_resolved INTEGER NOT NULL,
    artifact_type TEXT,
    data_json TEXT,
    PRIMARY KEY (solver_name, solver_version, category, method_id),
    UNIQUE (solver_name, solver_version, category, ordinal),
    FOREIGN KEY (solver_name, solver_version) REFERENCES solvers(name, version) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_method_parameters (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    category TEXT NOT NULL,
    method_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (solver_name, solver_version, category, method_id, name),
    UNIQUE (solver_name, solver_version, category, method_id, ordinal),
    FOREIGN KEY (solver_name, solver_version, category, method_id)
      REFERENCES solver_methods(solver_name, solver_version, category, method_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE solver_quantity_kind_usages (
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    quantity_kind TEXT NOT NULL REFERENCES quantity_kinds(name),
    context TEXT NOT NULL,
    path TEXT NOT NULL,
    unit TEXT,
    PRIMARY KEY (solver_name, solver_version, ordinal),
    UNIQUE (solver_name, solver_version, context, path),
    FOREIGN KEY (solver_name, solver_version) REFERENCES solvers(name, version) ON DELETE CASCADE
) STRICT;

CREATE TABLE experiments (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL,
    namespace TEXT NOT NULL,
    repository_slug TEXT NOT NULL,
    version_major INTEGER NOT NULL,
    version_minor INTEGER NOT NULL,
    version_patch INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    bundle_hash TEXT NOT NULL,
    UNIQUE (namespace, repository_slug, key, version_major, version_minor, version_patch)
) STRICT;

CREATE TABLE experiment_files (
    experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    path TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (experiment_id, path),
    UNIQUE (experiment_id, ordinal)
) STRICT;

CREATE TABLE experiment_concepts (
    experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    concept TEXT NOT NULL,
    PRIMARY KEY (experiment_id, ordinal),
    UNIQUE (experiment_id, concept)
) STRICT;

CREATE TABLE experiment_solvers (
    experiment_id INTEGER NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    solver_name TEXT NOT NULL,
    solver_version TEXT NOT NULL,
    PRIMARY KEY (experiment_id, solver_name, solver_version),
    UNIQUE (experiment_id, ordinal),
    FOREIGN KEY (solver_name, solver_version) REFERENCES solvers(name, version)
) STRICT;

CREATE INDEX experiment_solvers_solver_idx
ON experiment_solvers(solver_name, solver_version, experiment_id);

CREATE INDEX experiments_key_idx ON experiments(key);

CREATE VIEW solver_material_requirements AS
SELECT g.solver_name, g.solver_version, g.role, r.description AS role_description,
       r.target_category, r.target_method_id, g.key AS group_key, g.required,
       o.model_key
FROM solver_material_model_groups AS g
JOIN solver_material_roles AS r
  ON r.solver_name = g.solver_name AND r.solver_version = g.solver_version AND r.role = g.role
JOIN solver_material_model_options AS o
  ON o.solver_name = g.solver_name AND o.solver_version = g.solver_version
 AND o.role = g.role AND o.group_key = g.key;

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
"""


def create_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(SCHEMA_SQL)
    connection.execute(f"PRAGMA application_id = {APPLICATION_ID}")
    connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
