"""Replace legacy model artifacts with Calculation source.

Revision ID: 000000000002
Revises: 000000000001
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "000000000002"
down_revision = "000000000001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    table_names = set(sa.inspect(bind).get_table_names())

    if "designer_models" in table_names:
        op.drop_table("designer_models")
    if "predictor_models" in table_names:
        op.drop_table("predictor_models")
    if "calculations" in table_names:
        return

    op.create_table(
        "calculations",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            "experiment_id",
            sa.Integer(),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("source_code", sa.Text(), nullable=False),
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
            name="fk_calculations_experiment_id_experiments",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_calculations"),
        sa.UniqueConstraint(
            "experiment_id",
            "name",
            name="uq_calculations_experiment_id_name",
        ),
    )
    op.create_index(
        "ix_calculations_experiment_id",
        "calculations",
        ["experiment_id"],
        unique=False,
    )


def downgrade() -> None:
    raise RuntimeError(
        "Calculation migration deleted legacy model rows and does not support downgrade recovery"
    )
