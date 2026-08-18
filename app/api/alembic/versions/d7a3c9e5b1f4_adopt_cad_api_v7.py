"""adopt CAD API v7

Revision ID: d7a3c9e5b1f4
Revises: c92e1f4a6b38
Create Date: 2026-08-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "d7a3c9e5b1f4"
down_revision: str | None = "c92e1f4a6b38"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _discard_incompatible_data() -> None:
    # User accounts, namespaces, Geometry repositories/packages, and catalog
    # tables remain valid and are intentionally preserved.
    op.execute("DELETE FROM recorded_data")
    op.execute("DELETE FROM measurements")
    op.execute("DELETE FROM designer_models")
    op.execute("DELETE FROM predictor_models")
    op.execute("DELETE FROM experiments")

    # Published module hashes include the CAD API version. Existing immutable
    # versions cannot be rewritten, so only imports and versions are removed.
    op.execute("SELECT set_config('caemble.geometry_delete', 'on', true)")
    op.execute("DELETE FROM geometry_imports")
    op.execute("DELETE FROM geometry_versions")


def _set_cad_api_version(version: int) -> None:
    op.drop_constraint(
        op.f("ck_geometry_versions_cad_api_version_supported"),
        "geometry_versions",
        type_="check",
    )
    op.alter_column(
        "geometry_versions",
        "cad_api_version",
        existing_type=sa.Integer(),
        server_default=sa.text(str(version)),
        existing_nullable=False,
    )
    op.create_check_constraint(
        op.f("ck_geometry_versions_cad_api_version_supported"),
        "geometry_versions",
        f"cad_api_version = {version}",
    )


def upgrade() -> None:
    _discard_incompatible_data()
    _set_cad_api_version(7)


def downgrade() -> None:
    _discard_incompatible_data()
    _set_cad_api_version(6)
