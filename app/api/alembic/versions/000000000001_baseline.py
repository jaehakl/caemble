"""Create the trusted-input application schema.

Revision ID: 000000000001
Revises:
"""

from __future__ import annotations

from pathlib import Path
import sys

from alembic import op


APP_DIR = Path(__file__).resolve().parents[2] / "app"
sys.path.insert(0, str(APP_DIR))

from db import Base  # noqa: E402
from user_auth.db import Role  # noqa: E402
import gpstation.db  # noqa: E402, F401


revision = "000000000001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    Base.metadata.create_all(bind=op.get_bind(), checkfirst=False)
    op.bulk_insert(Role.__table__, [{"name": "user"}, {"name": "admin"}])


def downgrade() -> None:
    raise RuntimeError("The destructive baseline does not support downgrade recovery")
