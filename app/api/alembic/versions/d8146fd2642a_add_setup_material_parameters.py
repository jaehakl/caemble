"""add setup material parameters

Revision ID: d8146fd2642a
Revises: c7e4b127f3d2
Create Date: 2026-07-22
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "d8146fd2642a"
down_revision: Union[str, Sequence[str], None] = "c7e4b127f3d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "setups",
        sa.Column(
            "material_parameters",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("setups", "material_parameters")
