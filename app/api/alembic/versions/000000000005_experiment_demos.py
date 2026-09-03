"""Add curated public Experiment demos.

Revision ID: 000000000005
Revises: 000000000004
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "000000000005"
down_revision = "000000000004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "experiment_demos" in set(sa.inspect(op.get_bind()).get_table_names()):
        return
    op.create_table(
        "experiment_demos",
        sa.Column("experiment_id", sa.Integer(), nullable=False),
        sa.Column("display_order", sa.Integer(), nullable=False),
        sa.Column("is_default", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "display_order >= 0",
            name="ck_experiment_demos_display_order_nonnegative",
        ),
        sa.ForeignKeyConstraint(
            ["experiment_id"],
            ["experiments.id"],
            name="fk_experiment_demos_experiment_id_experiments",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("experiment_id", name="pk_experiment_demos"),
        sa.UniqueConstraint("display_order", name="uq_experiment_demos_display_order"),
    )
    op.create_index(
        "uq_experiment_demos_single_default",
        "experiment_demos",
        ["is_default"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )


def downgrade() -> None:
    op.drop_index("uq_experiment_demos_single_default", table_name="experiment_demos")
    op.drop_table("experiment_demos")
