"""adopt material roles and CAD API v6

Revision ID: c92e1f4a6b38
Revises: b31f7d9a4c20
Create Date: 2026-08-14
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "c92e1f4a6b38"
down_revision: str | None = "b31f7d9a4c20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _discard_incompatible_data() -> None:
    # Material catalog rows remain valid and are intentionally preserved.
    op.execute("DELETE FROM recorded_data")
    op.execute("DELETE FROM measurements")
    op.execute("DELETE FROM designer_models")
    op.execute("DELETE FROM predictor_models")
    op.execute("DELETE FROM experiments")

    # Immutable Geometry rows cannot be rewritten from positional material
    # arrays to role maps. The session flag authorizes the protected cleanup.
    op.execute("SELECT set_config('caemble.geometry_delete', 'on', true)")
    op.execute("DELETE FROM geometry_imports")
    op.execute("DELETE FROM geometry_versions")
    op.execute("DELETE FROM geometry_packages")
    op.execute("DROP TRIGGER protect_geometry_repository_identity ON geometry_repositories")
    op.execute("DELETE FROM geometry_repositories")
    op.execute(
        """
        CREATE TRIGGER protect_geometry_repository_identity
        BEFORE UPDATE OR DELETE ON geometry_repositories
        FOR EACH ROW
        EXECUTE FUNCTION protect_geometry_repository_identity()
        """
    )


def _set_geometry_versions(*, module_format_version: int, cad_api_version: int) -> None:
    op.drop_constraint(
        op.f("ck_geometry_versions_module_format_version_supported"),
        "geometry_versions",
        type_="check",
    )
    op.alter_column(
        "geometry_versions",
        "module_format_version",
        existing_type=sa.Integer(),
        server_default=sa.text(str(module_format_version)),
        existing_nullable=False,
    )
    op.create_check_constraint(
        op.f("ck_geometry_versions_module_format_version_supported"),
        "geometry_versions",
        f"module_format_version = {module_format_version}",
    )

    op.drop_constraint(
        op.f("ck_geometry_versions_cad_api_version_supported"),
        "geometry_versions",
        type_="check",
    )
    op.alter_column(
        "geometry_versions",
        "cad_api_version",
        existing_type=sa.Integer(),
        server_default=sa.text(str(cad_api_version)),
        existing_nullable=False,
    )
    op.create_check_constraint(
        op.f("ck_geometry_versions_cad_api_version_supported"),
        "geometry_versions",
        f"cad_api_version = {cad_api_version}",
    )


def upgrade() -> None:
    _discard_incompatible_data()
    _set_geometry_versions(module_format_version=4, cad_api_version=6)


def downgrade() -> None:
    _discard_incompatible_data()
    _set_geometry_versions(module_format_version=3, cad_api_version=5)
