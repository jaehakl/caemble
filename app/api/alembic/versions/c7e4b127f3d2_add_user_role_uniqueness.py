"""add user role uniqueness

Revision ID: c7e4b127f3d2
Revises: a20c9f5c5f6a
Create Date: 2026-07-21 22:40:00

"""
from typing import Sequence, Union

from alembic import op


revision: str = "c7e4b127f3d2"
down_revision: Union[str, Sequence[str], None] = "a20c9f5c5f6a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_unique_constraint(
        "uq_user_roles_user_id_role_id",
        "user_roles",
        ["user_id", "role_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_user_roles_user_id_role_id",
        "user_roles",
        type_="unique",
    )
