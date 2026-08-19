"""add AI provider credentials

Revision ID: a6e4c8f2d901
Revises: d7a3c9e5b1f4
Create Date: 2026-08-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "a6e4c8f2d901"
down_revision: str | None = "d7a3c9e5b1f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ai_provider_credentials",
        sa.Column("id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("encrypted_api_key", sa.LargeBinary(), nullable=False),
        sa.Column("version", sa.Integer(), server_default=sa.text("1"), nullable=False),
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
        sa.CheckConstraint(
            "version >= 1",
            name=op.f("ck_ai_provider_credentials_version_positive"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_ai_provider_credentials_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ai_provider_credentials")),
        sa.UniqueConstraint(
            "user_id",
            "provider",
            name="uq_ai_provider_credentials_user_id_provider",
        ),
    )


def downgrade() -> None:
    op.drop_table("ai_provider_credentials")
