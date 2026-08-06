"""add measurement sample setup uniqueness

Revision ID: b6e2a21f4c9d
Revises: f3a97c1248be
Create Date: 2026-07-23
"""

from typing import Sequence, Union

from alembic import op


revision: str = "b6e2a21f4c9d"
down_revision: Union[str, Sequence[str], None] = "f3a97c1248be"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        WITH ranked_measurements AS (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY sample_id, setup_id
                    ORDER BY updated_at DESC, id DESC
                ) AS duplicate_rank
            FROM measurements
        )
        DELETE FROM measurements
        WHERE id IN (
            SELECT id
            FROM ranked_measurements
            WHERE duplicate_rank > 1
        )
        """
    )
    op.create_unique_constraint(
        "uq_measurements_sample_id_setup_id",
        "measurements",
        ["sample_id", "setup_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_measurements_sample_id_setup_id",
        "measurements",
        type_="unique",
    )
