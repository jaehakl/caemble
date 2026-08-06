"""add material color

Revision ID: f3a97c1248be
Revises: d8146fd2642a
Create Date: 2026-07-22
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f3a97c1248be"
down_revision: Union[str, Sequence[str], None] = "d8146fd2642a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("materials", sa.Column("color", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("materials", "color")
