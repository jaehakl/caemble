from __future__ import annotations

import sqlite3

APPLICATION_ID = 0x4341454D  # "CAEM"
SCHEMA_VERSION = 1

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
"""


def create_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(SCHEMA_SQL)
    connection.execute(f"PRAGMA application_id = {APPLICATION_ID}")
    connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
