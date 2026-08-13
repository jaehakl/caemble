"""add Geometry Manager reference projection and controlled cleanup

Revision ID: 7b2d8f4a6c10
Revises: 4c91e2a7b5d8
Create Date: 2026-08-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "7b2d8f4a6c10"
down_revision: str | None = "4c91e2a7b5d8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _install_runtime_guards(*, namespace_mutable: bool, controlled_delete: bool) -> None:
    immutable_namespace = "" if namespace_mutable else """
            IF TG_OP = 'UPDATE'
               AND OLD.geometry_namespace IS NOT NULL
               AND OLD.geometry_namespace IS DISTINCT FROM NEW.geometry_namespace THEN
                RAISE EXCEPTION 'Geometry namespace cannot be changed after it is set';
            END IF;
    """
    delete_guard = (
        "IF current_setting('caemble.geometry_delete', true) IS DISTINCT FROM 'on' THEN"
        if controlled_delete
        else "IF TRUE THEN"
    )
    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION guard_geometry_namespace_reservation()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            {immutable_namespace}
            IF NEW.geometry_namespace IS NOT NULL AND EXISTS (
                SELECT 1
                FROM geometry_repositories
                WHERE namespace = NEW.geometry_namespace
                  AND user_id IS DISTINCT FROM NEW.id
            ) THEN
                RAISE EXCEPTION 'Geometry namespace is already reserved'
                    USING ERRCODE = 'unique_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION protect_geometry_package_identity()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                {delete_guard}
                    RAISE EXCEPTION 'Geometry packages cannot be deleted';
                END IF;
                RETURN OLD;
            END IF;
            IF OLD.repository_id IS DISTINCT FROM NEW.repository_id
               OR OLD.name IS DISTINCT FROM NEW.name THEN
                RAISE EXCEPTION 'Published Geometry package identity is immutable';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION protect_geometry_version()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                {delete_guard}
                    RAISE EXCEPTION 'Published Geometry versions cannot be deleted';
                END IF;
                RETURN OLD;
            END IF;
            IF OLD.package_id IS DISTINCT FROM NEW.package_id
               OR OLD.version_major IS DISTINCT FROM NEW.version_major
               OR OLD.version_minor IS DISTINCT FROM NEW.version_minor
               OR OLD.version_patch IS DISTINCT FROM NEW.version_patch
               OR OLD.description IS DISTINCT FROM NEW.description
               OR OLD.source IS DISTINCT FROM NEW.source
               OR OLD.source_hash IS DISTINCT FROM NEW.source_hash
               OR OLD.module_hash IS DISTINCT FROM NEW.module_hash
               OR OLD.module_format_version IS DISTINCT FROM NEW.module_format_version
               OR OLD.cad_api_version IS DISTINCT FROM NEW.cad_api_version
               OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL) THEN
                RAISE EXCEPTION 'Published Geometry version content is immutable';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        f"""
        CREATE OR REPLACE FUNCTION protect_geometry_import()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                {delete_guard}
                    RAISE EXCEPTION 'Published Geometry imports are immutable';
                END IF;
                RETURN OLD;
            END IF;
            RAISE EXCEPTION 'Published Geometry imports are immutable';
        END;
        $$
        """
    )


def upgrade() -> None:
    op.create_table(
        "experiment_geometry_modules",
        sa.Column("experiment_id", sa.Integer(), nullable=False),
        sa.Column("geometry_version_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["experiment_id"],
            ["experiments.id"],
            name=op.f("fk_experiment_geometry_modules_experiment_id_experiments"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["geometry_version_id"],
            ["geometry_versions.id"],
            name=op.f("fk_experiment_geometry_modules_geometry_version_id_geometry_versions"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint(
            "experiment_id",
            "geometry_version_id",
            name=op.f("pk_experiment_geometry_modules"),
        ),
    )
    op.create_index(
        op.f("ix_experiment_geometry_modules_geometry_version_id"),
        "experiment_geometry_modules",
        ["geometry_version_id"],
        unique=False,
    )
    op.execute(
        """
        INSERT INTO experiment_geometry_modules (experiment_id, geometry_version_id)
        SELECT DISTINCT experiments.id, (module.value ->> 'geometryVersionId')::integer
        FROM experiments
        CROSS JOIN LATERAL jsonb_array_elements(
            experiments.source_bundle -> 'geometrySnapshot' -> 'modules'
        ) AS module(value)
        WHERE experiments.source_bundle ->> 'formatVersion' = '3'
        ON CONFLICT DO NOTHING
        """
    )
    _install_runtime_guards(namespace_mutable=True, controlled_delete=True)


def downgrade() -> None:
    _install_runtime_guards(namespace_mutable=False, controlled_delete=False)
    op.drop_index(
        op.f("ix_experiment_geometry_modules_geometry_version_id"),
        table_name="experiment_geometry_modules",
    )
    op.drop_table("experiment_geometry_modules")
