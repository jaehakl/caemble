"""use atomic multi-file experiment source bundles

Revision ID: d2f7a1c9e4b6
Revises: b17d4c2e8a90
Create Date: 2026-08-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "d2f7a1c9e4b6"
down_revision: str | Sequence[str] | None = "b17d4c2e8a90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _require_empty_experiments() -> None:
    experiment_count = op.get_bind().execute(sa.text("SELECT count(*) FROM experiments")).scalar_one()
    if experiment_count:
        raise RuntimeError(
            "Experiment source bundles cannot be migrated while experiments contains rows. "
            "Remove the existing Experiments and their dependent records first."
        )


def upgrade() -> None:
    _require_empty_experiments()
    op.add_column(
        "experiments",
        sa.Column("source_bundle", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    )
    op.drop_column("experiments", "simulation_code")
    op.drop_column("experiments", "code")


def downgrade() -> None:
    _require_empty_experiments()
    op.add_column("experiments", sa.Column("code", sa.Text(), nullable=False))
    op.add_column("experiments", sa.Column("simulation_code", sa.Text(), nullable=True))
    op.drop_column("experiments", "source_bundle")
