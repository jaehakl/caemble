"""add immutable Geometry module repositories and Experiment snapshots

Revision ID: 4c91e2a7b5d8
Revises: f6a8c1d2e3b4
Create Date: 2026-08-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector


revision: str = "4c91e2a7b5d8"
down_revision: str | Sequence[str] | None = "f6a8c1d2e3b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _require_empty_legacy_geometries() -> None:
    geometry_count = op.get_bind().execute(sa.text("SELECT count(*) FROM geometries")).scalar_one()
    if geometry_count:
        raise RuntimeError(
            "Immutable Geometry modules cannot be migrated while geometries contains rows. "
            "Export the legacy rows as JSON and complete a manual repository/package/version mapping first; "
            "this migration will not convert or delete them."
        )


def _require_empty_new_geometry_data() -> None:
    bind = op.get_bind()
    for table in (
        "experiment_geometry_roots",
        "geometry_imports",
        "geometry_versions",
        "geometry_packages",
        "geometry_repositories",
    ):
        if bind.execute(sa.text(f"SELECT count(*) FROM {table}")).scalar_one():
            raise RuntimeError(f"Cannot downgrade while {table} contains rows.")
    if bind.execute(
        sa.text("SELECT count(*) FROM users WHERE geometry_namespace IS NOT NULL")
    ).scalar_one():
        raise RuntimeError("Cannot downgrade while users have Geometry namespaces.")


def upgrade() -> None:
    _require_empty_legacy_geometries()
    op.add_column("users", sa.Column("geometry_namespace", sa.Text(), nullable=True))
    op.create_check_constraint(
        op.f("ck_users_geometry_namespace_format"),
        "users",
        "geometry_namespace IS NULL OR geometry_namespace ~ "
        "'^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$'",
    )
    op.create_unique_constraint(
        op.f("uq_users_geometry_namespace"),
        "users",
        ["geometry_namespace"],
    )
    op.drop_table("geometries")

    op.create_table(
        "geometry_repositories",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=True),
        sa.Column("namespace", sa.Text(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
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
            "slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'",
            name=op.f("ck_geometry_repositories_slug_format"),
        ),
        sa.CheckConstraint(
            "namespace ~ '^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$'",
            name=op.f("ck_geometry_repositories_namespace_format"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_geometry_repositories_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_geometry_repositories")),
        sa.UniqueConstraint(
            "namespace",
            "slug",
            name="uq_geometry_repositories_namespace_slug",
        ),
    )
    op.create_table(
        "geometry_packages",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("repository_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
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
            "name ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'",
            name=op.f("ck_geometry_packages_name_format"),
        ),
        sa.ForeignKeyConstraint(
            ["repository_id"],
            ["geometry_repositories.id"],
            name=op.f("fk_geometry_packages_repository_id_geometry_repositories"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_geometry_packages")),
        sa.UniqueConstraint(
            "repository_id",
            "name",
            name="uq_geometry_packages_repository_id_name",
        ),
    )
    op.create_table(
        "geometry_versions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("package_id", sa.Integer(), nullable=False),
        sa.Column("version_major", sa.Integer(), nullable=False),
        sa.Column("version_minor", sa.Integer(), nullable=False),
        sa.Column("version_patch", sa.Integer(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("source_hash", sa.Text(), nullable=False),
        sa.Column("module_hash", sa.Text(), nullable=False),
        sa.Column("module_format_version", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("cad_api_version", sa.Integer(), server_default=sa.text("5"), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.CheckConstraint("version_major >= 0", name=op.f("ck_geometry_versions_version_major_nonnegative")),
        sa.CheckConstraint("version_minor >= 0", name=op.f("ck_geometry_versions_version_minor_nonnegative")),
        sa.CheckConstraint("version_patch >= 0", name=op.f("ck_geometry_versions_version_patch_nonnegative")),
        sa.CheckConstraint(
            "source_hash ~ '^[0-9a-f]{64}$'",
            name=op.f("ck_geometry_versions_source_hash_sha256"),
        ),
        sa.CheckConstraint(
            "module_hash ~ '^[0-9a-f]{64}$'",
            name=op.f("ck_geometry_versions_module_hash_sha256"),
        ),
        sa.CheckConstraint(
            "module_format_version = 1",
            name=op.f("ck_geometry_versions_module_format_version_supported"),
        ),
        sa.CheckConstraint(
            "cad_api_version = 5",
            name=op.f("ck_geometry_versions_cad_api_version_supported"),
        ),
        sa.ForeignKeyConstraint(
            ["package_id"],
            ["geometry_packages.id"],
            name=op.f("fk_geometry_versions_package_id_geometry_packages"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_geometry_versions")),
        sa.UniqueConstraint(
            "package_id",
            "version_major",
            "version_minor",
            "version_patch",
            name="uq_geometry_versions_package_id_semver",
        ),
    )
    op.create_index(
        op.f("ix_geometry_versions_package_id"),
        "geometry_versions",
        ["package_id"],
        unique=False,
    )
    op.execute(
        """
        CREATE FUNCTION archive_geometry_repositories_before_user_delete()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            UPDATE geometry_repositories
            SET archived_at = COALESCE(archived_at, now()), updated_at = now()
            WHERE user_id = OLD.id;
            RETURN OLD;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER archive_geometry_repositories_before_user_delete
        BEFORE DELETE ON users
        FOR EACH ROW
        EXECUTE FUNCTION archive_geometry_repositories_before_user_delete()
        """
    )
    op.execute(
        """
        CREATE FUNCTION guard_geometry_namespace_reservation()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF TG_OP = 'UPDATE'
               AND OLD.geometry_namespace IS NOT NULL
               AND OLD.geometry_namespace IS DISTINCT FROM NEW.geometry_namespace THEN
                RAISE EXCEPTION 'Geometry namespace cannot be changed after it is set';
            END IF;
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
        """
        CREATE TRIGGER guard_geometry_namespace_reservation
        BEFORE INSERT OR UPDATE OF geometry_namespace ON users
        FOR EACH ROW
        EXECUTE FUNCTION guard_geometry_namespace_reservation()
        """
    )
    op.execute(
        """
        CREATE FUNCTION validate_geometry_repository_owner_namespace()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF NEW.user_id IS NOT NULL AND NOT EXISTS (
                SELECT 1
                FROM users
                WHERE id = NEW.user_id
                  AND geometry_namespace = NEW.namespace
            ) THEN
                RAISE EXCEPTION 'Geometry repository namespace must match its owner';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER validate_geometry_repository_owner_namespace
        BEFORE INSERT OR UPDATE OF user_id, namespace ON geometry_repositories
        FOR EACH ROW
        EXECUTE FUNCTION validate_geometry_repository_owner_namespace()
        """
    )
    op.create_table(
        "geometry_imports",
        sa.Column("importer_geometry_version_id", sa.Integer(), nullable=False),
        sa.Column("imported_geometry_version_id", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "importer_geometry_version_id <> imported_geometry_version_id",
            name=op.f("ck_geometry_imports_not_self"),
        ),
        sa.ForeignKeyConstraint(
            ["imported_geometry_version_id"],
            ["geometry_versions.id"],
            name=op.f("fk_geometry_imports_imported_geometry_version_id_geometry_versions"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["importer_geometry_version_id"],
            ["geometry_versions.id"],
            name=op.f("fk_geometry_imports_importer_geometry_version_id_geometry_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "importer_geometry_version_id",
            "imported_geometry_version_id",
            name=op.f("pk_geometry_imports"),
        ),
    )
    op.create_table(
        "experiment_geometry_roots",
        sa.Column("experiment_id", sa.Integer(), nullable=False),
        sa.Column("alias", sa.Text(), nullable=False),
        sa.Column("geometry_version_id", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "alias ~ '^[A-Za-z_][A-Za-z0-9_]*$'",
            name=op.f("ck_experiment_geometry_roots_alias_identifier"),
        ),
        sa.ForeignKeyConstraint(
            ["experiment_id"],
            ["experiments.id"],
            name=op.f("fk_experiment_geometry_roots_experiment_id_experiments"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["geometry_version_id"],
            ["geometry_versions.id"],
            name=op.f("fk_experiment_geometry_roots_geometry_version_id_geometry_versions"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("experiment_id", "alias", name=op.f("pk_experiment_geometry_roots")),
    )
    op.create_index(
        op.f("ix_experiment_geometry_roots_geometry_version_id"),
        "experiment_geometry_roots",
        ["geometry_version_id"],
        unique=False,
    )
    op.execute(
        """
        CREATE FUNCTION protect_geometry_repository_identity()
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
    op.execute(
        """
        CREATE TRIGGER protect_geometry_repository_identity
        BEFORE UPDATE OR DELETE ON geometry_repositories
        FOR EACH ROW
        EXECUTE FUNCTION protect_geometry_repository_identity()
        """
    )
    op.execute(
        """
        CREATE FUNCTION protect_geometry_package_identity()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                RAISE EXCEPTION 'Geometry packages cannot be deleted';
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
        """
        CREATE TRIGGER protect_geometry_package_identity
        BEFORE UPDATE OR DELETE ON geometry_packages
        FOR EACH ROW
        EXECUTE FUNCTION protect_geometry_package_identity()
        """
    )
    op.execute(
        """
        CREATE FUNCTION protect_geometry_version()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                RAISE EXCEPTION 'Published Geometry versions cannot be deleted';
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
        """
        CREATE TRIGGER protect_geometry_version
        BEFORE UPDATE OR DELETE ON geometry_versions
        FOR EACH ROW
        EXECUTE FUNCTION protect_geometry_version()
        """
    )
    op.execute(
        """
        CREATE FUNCTION protect_geometry_import()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            RAISE EXCEPTION 'Published Geometry imports are immutable';
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER protect_geometry_import
        BEFORE UPDATE OR DELETE ON geometry_imports
        FOR EACH ROW
        EXECUTE FUNCTION protect_geometry_import()
        """
    )


def downgrade() -> None:
    _require_empty_new_geometry_data()
    op.execute("DROP TRIGGER IF EXISTS protect_geometry_import ON geometry_imports")
    op.execute("DROP FUNCTION IF EXISTS protect_geometry_import()")
    op.execute("DROP TRIGGER IF EXISTS protect_geometry_version ON geometry_versions")
    op.execute("DROP FUNCTION IF EXISTS protect_geometry_version()")
    op.execute("DROP TRIGGER IF EXISTS protect_geometry_package_identity ON geometry_packages")
    op.execute("DROP FUNCTION IF EXISTS protect_geometry_package_identity()")
    op.execute("DROP TRIGGER IF EXISTS protect_geometry_repository_identity ON geometry_repositories")
    op.execute("DROP FUNCTION IF EXISTS protect_geometry_repository_identity()")
    op.execute("DROP TRIGGER IF EXISTS validate_geometry_repository_owner_namespace ON geometry_repositories")
    op.execute("DROP FUNCTION IF EXISTS validate_geometry_repository_owner_namespace()")
    op.execute("DROP TRIGGER IF EXISTS guard_geometry_namespace_reservation ON users")
    op.execute("DROP FUNCTION IF EXISTS guard_geometry_namespace_reservation()")
    op.execute("DROP TRIGGER IF EXISTS archive_geometry_repositories_before_user_delete ON users")
    op.execute("DROP FUNCTION IF EXISTS archive_geometry_repositories_before_user_delete()")
    op.drop_index(
        op.f("ix_experiment_geometry_roots_geometry_version_id"),
        table_name="experiment_geometry_roots",
    )
    op.drop_table("experiment_geometry_roots")
    op.drop_table("geometry_imports")
    op.drop_index(op.f("ix_geometry_versions_package_id"), table_name="geometry_versions")
    op.drop_table("geometry_versions")
    op.drop_table("geometry_packages")
    op.drop_table("geometry_repositories")
    op.create_table(
        "geometries",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=True),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("code_embedding", Vector(dim=768), nullable=True),
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
            ["parent_id"],
            ["geometries.id"],
            name=op.f("fk_geometries_parent_id_geometries"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_geometries_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_geometries")),
    )
    op.drop_constraint(op.f("uq_users_geometry_namespace"), "users", type_="unique")
    op.drop_constraint(op.f("ck_users_geometry_namespace_format"), "users", type_="check")
    op.drop_column("users", "geometry_namespace")
