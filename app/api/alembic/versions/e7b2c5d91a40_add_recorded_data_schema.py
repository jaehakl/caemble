"""add recorded data schema

Revision ID: e7b2c5d91a40
Revises: c4f8e21a9b6d
Create Date: 2026-08-06
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "e7b2c5d91a40"
down_revision: Union[str, Sequence[str], None] = "c4f8e21a9b6d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "recorded_data",
        sa.Column("data_schema", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.alter_column(
        "recorded_data",
        "quantity_kind",
        existing_type=sa.Text(),
        nullable=True,
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            UPDATE recorded_data
            SET quantity_kind = 'Dimensionless'
            WHERE quantity_kind IS NULL
            """
        )
    )
    op.alter_column(
        "recorded_data",
        "quantity_kind",
        existing_type=sa.Text(),
        nullable=False,
    )
    op.drop_column("recorded_data", "data_schema")
