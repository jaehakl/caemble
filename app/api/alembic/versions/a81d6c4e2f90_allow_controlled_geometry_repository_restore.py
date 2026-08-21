"""allow controlled Geometry Repository restore and delete

Revision ID: a81d6c4e2f90
Revises: f7c9d2a8e4b1
Create Date: 2026-08-21
"""

from collections.abc import Sequence

from alembic import op


revision: str = "a81d6c4e2f90"
down_revision: str | None = "f7c9d2a8e4b1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION protect_geometry_repository_identity()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                IF current_setting('caemble.geometry_delete', true) IS DISTINCT FROM 'on' THEN
                    RAISE EXCEPTION 'Geometry repositories cannot be deleted';
                END IF;
                RETURN OLD;
            END IF;
            IF OLD.namespace IS DISTINCT FROM NEW.namespace
               OR OLD.slug IS DISTINCT FROM NEW.slug
               OR (OLD.user_id IS DISTINCT FROM NEW.user_id AND NEW.user_id IS NOT NULL)
               OR (
                   OLD.archived_at IS NOT NULL
                   AND NEW.archived_at IS NULL
                   AND current_setting('caemble.geometry_repository_restore', true) IS DISTINCT FROM 'on'
               ) THEN
                RAISE EXCEPTION 'Published Geometry repository identity is immutable';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )


def downgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION protect_geometry_repository_identity()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                RAISE EXCEPTION 'Geometry repositories cannot be deleted';
            END IF;
            IF OLD.namespace IS DISTINCT FROM NEW.namespace
               OR OLD.slug IS DISTINCT FROM NEW.slug
               OR (OLD.user_id IS DISTINCT FROM NEW.user_id AND NEW.user_id IS NOT NULL)
               OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL) THEN
                RAISE EXCEPTION 'Published Geometry repository identity is immutable';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
