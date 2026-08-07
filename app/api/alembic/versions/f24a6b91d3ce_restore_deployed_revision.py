"""restore deployed revision marker

Revision ID: f24a6b91d3ce
Revises: e7b2c5d91a40
Create Date: 2026-08-07
"""

from typing import Sequence, Union


revision: str = "f24a6b91d3ce"
down_revision: Union[str, Sequence[str], None] = "e7b2c5d91a40"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
