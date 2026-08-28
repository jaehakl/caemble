"""Add persisted CalculationData outputs.

Revision ID: 000000000003
Revises: 000000000002
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "000000000003"
down_revision = "000000000002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "calculation_data" in set(sa.inspect(op.get_bind()).get_table_names()):
        return
    op.create_table(
        "calculation_data",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("calculation_id", sa.Integer(), nullable=False),
        sa.Column("measurement_id", sa.Integer(), nullable=False),
        sa.Column("data", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
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
            ["calculation_id"],
            ["calculations.id"],
            name="fk_calculation_data_calculation_id_calculations",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["measurement_id"],
            ["measurements.id"],
            name="fk_calculation_data_measurement_id_measurements",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_calculation_data"),
        sa.UniqueConstraint(
            "calculation_id",
            "measurement_id",
            name="uq_calculation_data_calculation_id_measurement_id",
        ),
    )
    op.create_index(
        "ix_calculation_data_measurement_id",
        "calculation_data",
        ["measurement_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_calculation_data_measurement_id", table_name="calculation_data")
    op.drop_table("calculation_data")
