"""switch published Geometry modules to function components

Revision ID: 8d4e2f6a1b30
Revises: 7b2d8f4a6c10
Create Date: 2026-08-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "8d4e2f6a1b30"
down_revision: str | None = "7b2d8f4a6c10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _discard_geometry_data() -> None:
    op.execute(
        """
        CREATE TEMPORARY TABLE discarded_geometry_experiments
        ON COMMIT DROP
        AS
        SELECT DISTINCT experiments.id
        FROM experiments
        WHERE EXISTS (
            SELECT 1
            FROM experiment_geometry_modules
            WHERE experiment_geometry_modules.experiment_id = experiments.id
        )
        OR EXISTS (
            SELECT 1
            FROM experiment_geometry_roots
            WHERE experiment_geometry_roots.experiment_id = experiments.id
        )
        OR CASE
            WHEN jsonb_typeof(experiments.source_bundle->'geometrySnapshot'->'modules') = 'array'
            THEN jsonb_array_length(experiments.source_bundle->'geometrySnapshot'->'modules') > 0
            ELSE FALSE
        END
        OR CASE
            WHEN jsonb_typeof(experiments.source_bundle->'geometrySnapshot'->'roots') = 'array'
            THEN jsonb_array_length(experiments.source_bundle->'geometrySnapshot'->'roots') > 0
            ELSE FALSE
        END
        """
    )
    op.execute(
        """
        DELETE FROM measurements
        WHERE experiment_id IN (SELECT id FROM discarded_geometry_experiments)
        """
    )
    op.execute(
        """
        DELETE FROM experiments
        WHERE id IN (SELECT id FROM discarded_geometry_experiments)
        """
    )
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


def _set_module_format(version: int) -> None:
    op.drop_constraint(
        op.f("ck_geometry_versions_module_format_version_supported"),
        "geometry_versions",
        type_="check",
    )
    op.alter_column(
        "geometry_versions",
        "module_format_version",
        existing_type=sa.Integer(),
        server_default=sa.text(str(version)),
        existing_nullable=False,
    )
    op.create_check_constraint(
        op.f("ck_geometry_versions_module_format_version_supported"),
        "geometry_versions",
        f"module_format_version = {version}",
    )


def upgrade() -> None:
    _discard_geometry_data()
    _set_module_format(2)


def downgrade() -> None:
    _discard_geometry_data()
    _set_module_format(1)
