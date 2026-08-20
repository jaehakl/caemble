"""adopt CAD API v8

Revision ID: f7c9d2a8e4b1
Revises: a6e4c8f2d901
Create Date: 2026-08-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "f7c9d2a8e4b1"
down_revision: str | None = "a6e4c8f2d901"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _set_cad_api_constraint(expression: str, default: int) -> None:
    op.drop_constraint(
        op.f("ck_geometry_versions_cad_api_version_supported"),
        "geometry_versions",
        type_="check",
    )
    op.alter_column(
        "geometry_versions",
        "cad_api_version",
        existing_type=sa.Integer(),
        server_default=sa.text(str(default)),
        existing_nullable=False,
    )
    op.create_check_constraint(
        op.f("ck_geometry_versions_cad_api_version_supported"),
        "geometry_versions",
        expression,
    )


def upgrade() -> None:
    _set_cad_api_constraint("cad_api_version IN (7, 8)", 8)


def downgrade() -> None:
    op.execute(
        """
        CREATE TEMPORARY TABLE cad_api_v8_geometry_versions (
            id integer PRIMARY KEY
        ) ON COMMIT DROP
        """
    )
    op.execute(
        """
        WITH RECURSIVE affected(id) AS (
            SELECT id FROM geometry_versions WHERE cad_api_version = 8
            UNION
            SELECT imports.importer_geometry_version_id
            FROM geometry_imports AS imports
            JOIN affected ON affected.id = imports.imported_geometry_version_id
        )
        INSERT INTO cad_api_v8_geometry_versions (id)
        SELECT id FROM affected
        """
    )
    op.execute(
        """
        CREATE TEMPORARY TABLE cad_api_v8_experiments (
            id integer PRIMARY KEY
        ) ON COMMIT DROP
        """
    )
    op.execute(
        """
        INSERT INTO cad_api_v8_experiments (id)
        SELECT DISTINCT modules.experiment_id
        FROM experiment_geometry_modules AS modules
        JOIN cad_api_v8_geometry_versions AS affected
          ON affected.id = modules.geometry_version_id
        UNION
        SELECT experiments.id
        FROM experiments
        WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
                COALESCE(experiments.source_bundle->'geometrySnapshot'->'modules', '[]'::jsonb)
            ) AS module
            WHERE module->>'cadApiVersion' = '8'
        )
        """
    )
    op.execute(
        """
        DELETE FROM recorded_data
        WHERE measurement_id IN (
            SELECT measurements.id
            FROM measurements
            JOIN cad_api_v8_experiments AS affected
              ON affected.id = measurements.experiment_id
        )
        """
    )
    op.execute(
        "DELETE FROM measurements WHERE experiment_id IN (SELECT id FROM cad_api_v8_experiments)"
    )
    op.execute(
        "DELETE FROM designer_models WHERE experiment_id IN (SELECT id FROM cad_api_v8_experiments)"
    )
    op.execute(
        "DELETE FROM predictor_models WHERE experiment_id IN (SELECT id FROM cad_api_v8_experiments)"
    )
    op.execute("DELETE FROM experiments WHERE id IN (SELECT id FROM cad_api_v8_experiments)")

    op.execute("SELECT set_config('caemble.geometry_delete', 'on', true)")
    op.execute(
        """
        DELETE FROM geometry_imports
        WHERE importer_geometry_version_id IN (SELECT id FROM cad_api_v8_geometry_versions)
        OR imported_geometry_version_id IN (SELECT id FROM cad_api_v8_geometry_versions)
        """
    )
    op.execute("DELETE FROM geometry_versions WHERE id IN (SELECT id FROM cad_api_v8_geometry_versions)")
    _set_cad_api_constraint("cad_api_version = 7", 7)
