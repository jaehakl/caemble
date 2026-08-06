"""add per-user GPStation connections

Revision ID: 9d31a6f7c2e4
Revises: e7b2c5d91a40
Create Date: 2026-08-06
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "9d31a6f7c2e4"
down_revision: Union[str, Sequence[str], None] = "e7b2c5d91a40"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "gpstation_connections",
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("api_base_url", sa.Text(), nullable=False),
        sa.Column("access_token", sa.Text(), nullable=False),
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
            ["user_id"],
            ["users.id"],
            name=op.f("fk_gpstation_connections_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_gpstation_connections")),
    )


def downgrade() -> None:
    op.drop_table("gpstation_connections")
