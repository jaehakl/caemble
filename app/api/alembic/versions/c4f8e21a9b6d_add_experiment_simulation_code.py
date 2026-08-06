"""add experiment simulation code and remove persisted GPStation token

Revision ID: c4f8e21a9b6d
Revises: b6e2a21f4c9d
Create Date: 2026-08-06
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c4f8e21a9b6d"
down_revision: Union[str, Sequence[str], None] = "b6e2a21f4c9d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("experiments", sa.Column("simulation_code", sa.Text(), nullable=True))
    op.drop_column("users", "gps_access_token")


def downgrade() -> None:
    op.add_column("users", sa.Column("gps_access_token", sa.Text(), nullable=True))
    op.drop_column("experiments", "simulation_code")
