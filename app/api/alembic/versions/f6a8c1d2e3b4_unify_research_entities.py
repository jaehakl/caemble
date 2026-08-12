"""unify research entities

Revision ID: f6a8c1d2e3b4
Revises: e91f6b3a2c7d
Create Date: 2026-08-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql


revision: str = "f6a8c1d2e3b4"
down_revision: str | Sequence[str] | None = "e91f6b3a2c7d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EMPTY_SHA256 = "0" * 64


def upgrade() -> None:
    # The old split definitions and realizations cannot represent the unified
    # Experiment/Measurement contract. This revision intentionally resets only
    # the research-domain data; Geometry, catalogs, auth, and jobs are untouched.
    op.execute("DELETE FROM recorded_data")
    op.execute("DELETE FROM measurements")
    op.execute("DELETE FROM designer_models")
    op.execute("DELETE FROM predictor_models")
    op.execute("DELETE FROM samples")
    op.execute("DELETE FROM setups")
    op.execute("DELETE FROM structures")
    op.execute("DELETE FROM experiments")

    op.add_column(
        "experiments",
        sa.Column(
            "source_hash",
            sa.Text(),
            nullable=False,
            server_default=EMPTY_SHA256,
        ),
    )
    op.alter_column("experiments", "source_hash", server_default=None)
    op.create_check_constraint(
        op.f("ck_experiments_source_hash_sha256"),
        "experiments",
        "source_hash ~ '^[0-9a-f]{64}$'",
    )

    op.drop_constraint(
        "fk_designer_models_structure_id_structures",
        "designer_models",
        type_="foreignkey",
    )
    op.drop_column("designer_models", "structure_id")
    op.drop_constraint(
        "fk_predictor_models_structure_id_structures",
        "predictor_models",
        type_="foreignkey",
    )
    op.drop_column("predictor_models", "structure_id")

    op.drop_constraint(
        "uq_measurements_sample_id_setup_id",
        "measurements",
        type_="unique",
    )
    op.drop_index("ix_measurements_setup_id", table_name="measurements")
    op.drop_constraint(
        "fk_measurements_sample_id_samples",
        "measurements",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_measurements_setup_id_setups",
        "measurements",
        type_="foreignkey",
    )
    op.drop_column("measurements", "sample_id")
    op.drop_column("measurements", "setup_id")
    op.alter_column(
        "measurements",
        "user_id",
        existing_type=sa.UUID(as_uuid=False),
        nullable=False,
    )
    op.add_column("measurements", sa.Column("experiment_id", sa.Integer(), nullable=False))
    op.add_column(
        "measurements",
        sa.Column(
            "vars",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
    )
    op.add_column(
        "measurements",
        sa.Column(
            "material_parameters",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
    )
    op.add_column(
        "measurements",
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_measurements_experiment_id_experiments",
        "measurements",
        "experiments",
        ["experiment_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index(
        "ix_measurements_experiment_id",
        "measurements",
        ["experiment_id"],
        unique=False,
    )
    op.create_check_constraint(
        op.f("ck_measurements_vars_object"),
        "measurements",
        "jsonb_typeof(vars) = 'object'",
    )
    op.create_check_constraint(
        op.f("ck_measurements_material_parameters_object"),
        "measurements",
        "jsonb_typeof(material_parameters) = 'object'",
    )
    op.create_check_constraint(
        op.f("ck_measurements_material_parameters_v2"),
        "measurements",
        "material_parameters ?& ARRAY['schemaVersion', 'experiment', 'tasks'] "
        "AND material_parameters - 'schemaVersion' - 'experiment' - 'tasks' = '{}'::jsonb "
        "AND material_parameters->>'schemaVersion' = '2' "
        "AND jsonb_typeof(material_parameters->'experiment') = 'object' "
        "AND material_parameters->'experiment'->>'schemaVersion' = '1' "
        "AND jsonb_typeof(material_parameters->'experiment'->'materials') = 'object' "
        "AND jsonb_typeof(material_parameters->'tasks') = 'object'",
    )
    op.create_unique_constraint(
        "uq_recorded_data_measurement_id_name",
        "recorded_data",
        ["measurement_id", "name"],
    )
    op.alter_column(
        "recorded_data",
        "user_id",
        existing_type=sa.UUID(as_uuid=False),
        nullable=False,
    )

    op.drop_table("samples")
    op.drop_table("setups")
    op.drop_table("structures")


def downgrade() -> None:
    # Unified rows cannot be split back into Structure/Sample/Setup without
    # inventing data, so downgrade restores the old schema after the same
    # explicit research-domain reset.
    op.execute("DELETE FROM recorded_data")
    op.execute("DELETE FROM measurements")
    op.execute("DELETE FROM designer_models")
    op.execute("DELETE FROM predictor_models")
    op.execute("DELETE FROM experiments")

    op.create_table(
        "structures",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=True),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("code_embedding", Vector(dim=768), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["parent_id"],
            ["structures.id"],
            name="fk_structures_parent_id_structures",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_structures_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_structures"),
    )
    op.create_index("ix_structures_parent_id", "structures", ["parent_id"], unique=False)

    op.create_table(
        "samples",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=True),
        sa.Column("structure_id", sa.Integer(), nullable=False),
        sa.Column(
            "vars",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "material_parameters",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["structure_id"],
            ["structures.id"],
            name="fk_samples_structure_id_structures",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_samples_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_samples"),
    )
    op.create_index("ix_samples_structure_id", "samples", ["structure_id"], unique=False)

    op.create_table(
        "setups",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=True),
        sa.Column("experiment_id", sa.Integer(), nullable=False),
        sa.Column(
            "vars",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "material_parameters",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["experiment_id"],
            ["experiments.id"],
            name="fk_setups_experiment_id_experiments",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_setups_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_setups"),
    )
    op.create_index("ix_setups_experiment_id", "setups", ["experiment_id"], unique=False)

    op.add_column("designer_models", sa.Column("structure_id", sa.Integer(), nullable=False))
    op.create_foreign_key(
        "fk_designer_models_structure_id_structures",
        "designer_models",
        "structures",
        ["structure_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.add_column("predictor_models", sa.Column("structure_id", sa.Integer(), nullable=False))
    op.create_foreign_key(
        "fk_predictor_models_structure_id_structures",
        "predictor_models",
        "structures",
        ["structure_id"],
        ["id"],
        ondelete="CASCADE",
    )

    op.drop_constraint(
        "uq_recorded_data_measurement_id_name",
        "recorded_data",
        type_="unique",
    )
    op.alter_column(
        "recorded_data",
        "user_id",
        existing_type=sa.UUID(as_uuid=False),
        nullable=True,
    )
    op.drop_constraint(
        op.f("ck_measurements_material_parameters_v2"),
        "measurements",
        type_="check",
    )
    op.drop_constraint(
        op.f("ck_measurements_material_parameters_object"),
        "measurements",
        type_="check",
    )
    op.drop_constraint(
        op.f("ck_measurements_vars_object"),
        "measurements",
        type_="check",
    )
    op.drop_index("ix_measurements_experiment_id", table_name="measurements")
    op.drop_constraint(
        "fk_measurements_experiment_id_experiments",
        "measurements",
        type_="foreignkey",
    )
    op.drop_column("measurements", "recorded_at")
    op.drop_column("measurements", "material_parameters")
    op.drop_column("measurements", "vars")
    op.drop_column("measurements", "experiment_id")
    op.alter_column(
        "measurements",
        "user_id",
        existing_type=sa.UUID(as_uuid=False),
        nullable=True,
    )
    op.add_column("measurements", sa.Column("sample_id", sa.Integer(), nullable=False))
    op.add_column("measurements", sa.Column("setup_id", sa.Integer(), nullable=False))
    op.create_foreign_key(
        "fk_measurements_sample_id_samples",
        "measurements",
        "samples",
        ["sample_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_measurements_setup_id_setups",
        "measurements",
        "setups",
        ["setup_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_unique_constraint(
        "uq_measurements_sample_id_setup_id",
        "measurements",
        ["sample_id", "setup_id"],
    )
    op.create_index("ix_measurements_setup_id", "measurements", ["setup_id"], unique=False)

    op.drop_constraint(
        op.f("ck_experiments_source_hash_sha256"),
        "experiments",
        type_="check",
    )
    op.drop_column("experiments", "source_hash")
