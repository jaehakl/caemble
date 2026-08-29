"""Centralize RecordedData and Calculation layout contracts.

Revision ID: 000000000004
Revises: 000000000003
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "000000000004"
down_revision = "000000000003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())
    if "experiment_records" not in table_names:
        op.create_table(
            "experiment_records",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("experiment_id", sa.Integer(), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("quantity_kind", sa.Text(), nullable=True),
            sa.Column("tensor_order", sa.Integer(), nullable=False),
            sa.Column("dtype", sa.Text(), nullable=False),
            sa.Column("data_schema", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column("contract_hash", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.ForeignKeyConstraint(
                ["experiment_id"],
                ["experiments.id"],
                name="fk_experiment_records_experiment_id_experiments",
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id", name="pk_experiment_records"),
            sa.UniqueConstraint(
                "experiment_id",
                "name",
                name="uq_experiment_records_experiment_id_name",
            ),
        )
        op.create_index(
            "ix_experiment_records_experiment_id",
            "experiment_records",
            ["experiment_id"],
            unique=False,
        )

    recorded_columns = {column["name"] for column in inspector.get_columns("recorded_data")}
    if "experiment_record_id" not in recorded_columns:
        required_legacy_columns = {"name", "quantity_kind", "tensor_order", "dtype", "data_schema"}
        if not required_legacy_columns.issubset(recorded_columns):
            raise RuntimeError("RecordedData is neither the legacy nor ExperimentRecord layout.")
        op.execute(
            sa.text(
                """
                DO $$
                DECLARE conflict_detail text;
                BEGIN
                  SELECT string_agg(
                    format(
                      'Experiment %s / %s (Measurements %s; fields %s)',
                      conflict.experiment_id,
                      conflict.name,
                      conflict.measurement_ids,
                      conflict.differing_fields
                    ),
                    '; '
                  )
                  INTO conflict_detail
                  FROM (
                    SELECT
                      m.experiment_id,
                      rd.name,
                      string_agg(DISTINCT rd.measurement_id::text, ',' ORDER BY rd.measurement_id::text) AS measurement_ids,
                      concat_ws(',',
                        CASE WHEN count(DISTINCT coalesce(rd.quantity_kind, '<NULL>')) > 1 THEN 'quantity_kind' END,
                        CASE WHEN count(DISTINCT rd.tensor_order) > 1 THEN 'tensor_order' END,
                        CASE WHEN count(DISTINCT rd.dtype) > 1 THEN 'dtype' END,
                        CASE WHEN count(DISTINCT coalesce(rd.data_schema, 'null'::jsonb)) > 1 THEN 'data_schema' END
                      ) AS differing_fields
                    FROM recorded_data rd
                    JOIN measurements m ON m.id = rd.measurement_id
                    GROUP BY m.experiment_id, rd.name
                    HAVING count(DISTINCT jsonb_build_object(
                      'quantity_kind', rd.quantity_kind,
                      'tensor_order', rd.tensor_order,
                      'dtype', rd.dtype,
                      'data_schema', rd.data_schema
                    )) > 1
                  ) conflict;
                  IF conflict_detail IS NOT NULL THEN
                    RAISE EXCEPTION 'ExperimentRecord backfill found conflicting metadata: %', conflict_detail;
                  END IF;
                END $$;
                """
            )
        )
        op.execute(
            sa.text(
                """
                INSERT INTO experiment_records (
                  experiment_id, name, quantity_kind, tensor_order, dtype, data_schema, contract_hash
                )
                SELECT DISTINCT ON (m.experiment_id, rd.name)
                  m.experiment_id,
                  rd.name,
                  rd.quantity_kind,
                  rd.tensor_order,
                  rd.dtype,
                  rd.data_schema,
                  md5(jsonb_build_object(
                    'name', rd.name,
                    'quantity_kind', rd.quantity_kind,
                    'tensor_order', rd.tensor_order,
                    'dtype', rd.dtype,
                    'data_schema', rd.data_schema
                  )::text)
                FROM recorded_data rd
                JOIN measurements m ON m.id = rd.measurement_id
                ORDER BY m.experiment_id, rd.name, rd.id
                ON CONFLICT (experiment_id, name) DO NOTHING
                """
            )
        )
        op.add_column("recorded_data", sa.Column("experiment_record_id", sa.Integer(), nullable=True))
        op.execute(
            sa.text(
                """
                UPDATE recorded_data rd
                SET experiment_record_id = er.id
                FROM measurements m, experiment_records er
                WHERE m.id = rd.measurement_id
                  AND er.experiment_id = m.experiment_id
                  AND er.name = rd.name
                """
            )
        )
        op.alter_column("recorded_data", "experiment_record_id", nullable=False)
        op.create_foreign_key(
            "fk_recorded_data_experiment_record_id_experiment_records",
            "recorded_data",
            "experiment_records",
            ["experiment_record_id"],
            ["id"],
            ondelete="CASCADE",
        )
        op.create_index(
            "ix_recorded_data_experiment_record_id",
            "recorded_data",
            ["experiment_record_id"],
            unique=False,
        )
        op.drop_constraint("uq_recorded_data_measurement_id_name", "recorded_data", type_="unique")
        op.create_unique_constraint(
            "uq_recorded_data_measurement_id_experiment_record_id",
            "recorded_data",
            ["measurement_id", "experiment_record_id"],
        )
        for column in required_legacy_columns:
            op.drop_column("recorded_data", column)

    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())
    if "calculation_experiment_records" not in table_names:
        op.create_table(
            "calculation_experiment_records",
            sa.Column("calculation_id", sa.Integer(), nullable=False),
            sa.Column("experiment_record_id", sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(
                ["calculation_id"],
                ["calculations.id"],
                name="fk_calc_records_calculation",
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["experiment_record_id"],
                ["experiment_records.id"],
                name="fk_calc_records_record",
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint(
                "calculation_id",
                "experiment_record_id",
                name="pk_calculation_experiment_records",
            ),
        )

    calculation_columns = {column["name"] for column in inspector.get_columns("calculations")}
    if "source_hash" not in calculation_columns:
        op.add_column("calculations", sa.Column("source_hash", sa.Text(), nullable=True))
    if "output_layout" not in calculation_columns:
        op.add_column(
            "calculations",
            sa.Column("output_layout", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        )
    if "preflight_measurement_id" not in calculation_columns:
        op.add_column("calculations", sa.Column("preflight_measurement_id", sa.Integer(), nullable=True))
    if "contract_status" not in calculation_columns:
        op.add_column(
            "calculations",
            sa.Column(
                "contract_status",
                sa.Text(),
                server_default=sa.text("'needs_preflight'"),
                nullable=False,
            ),
        )
    calculation_foreign_keys = {
        foreign_key["name"] for foreign_key in sa.inspect(bind).get_foreign_keys("calculations")
    }
    if "fk_calculations_preflight_measurement_id_measurements" not in calculation_foreign_keys:
        op.create_foreign_key(
            "fk_calculations_preflight_measurement_id_measurements",
            "calculations",
            "measurements",
            ["preflight_measurement_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    bind = op.get_bind()
    if "experiment_records" not in set(sa.inspect(bind).get_table_names()):
        return
    op.add_column("recorded_data", sa.Column("data_schema", postgresql.JSONB(), nullable=True))
    op.add_column("recorded_data", sa.Column("dtype", sa.Text(), nullable=True))
    op.add_column("recorded_data", sa.Column("tensor_order", sa.Integer(), nullable=True))
    op.add_column("recorded_data", sa.Column("quantity_kind", sa.Text(), nullable=True))
    op.add_column("recorded_data", sa.Column("name", sa.Text(), nullable=True))
    op.execute(
        sa.text(
            """
            UPDATE recorded_data rd
            SET name = er.name,
                quantity_kind = er.quantity_kind,
                tensor_order = er.tensor_order,
                dtype = er.dtype,
                data_schema = er.data_schema
            FROM experiment_records er
            WHERE er.id = rd.experiment_record_id
            """
        )
    )
    for column in ("name", "tensor_order", "dtype"):
        op.alter_column("recorded_data", column, nullable=False)
    op.drop_constraint(
        "uq_recorded_data_measurement_id_experiment_record_id",
        "recorded_data",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_recorded_data_measurement_id_name",
        "recorded_data",
        ["measurement_id", "name"],
    )
    op.drop_index("ix_recorded_data_experiment_record_id", table_name="recorded_data")
    op.drop_constraint(
        "fk_recorded_data_experiment_record_id_experiment_records",
        "recorded_data",
        type_="foreignkey",
    )
    op.drop_column("recorded_data", "experiment_record_id")
    op.drop_constraint(
        "fk_calculations_preflight_measurement_id_measurements",
        "calculations",
        type_="foreignkey",
    )
    for column in ("contract_status", "preflight_measurement_id", "output_layout", "source_hash"):
        op.drop_column("calculations", column)
    op.drop_table("calculation_experiment_records")
    op.drop_index("ix_experiment_records_experiment_id", table_name="experiment_records")
    op.drop_table("experiment_records")
