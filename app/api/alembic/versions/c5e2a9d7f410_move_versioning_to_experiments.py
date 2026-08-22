"""move repository and SemVer identity to Experiments

Revision ID: c5e2a9d7f410
Revises: a81d6c4e2f90
Create Date: 2026-08-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "c5e2a9d7f410"
down_revision: str | Sequence[str] | None = "a81d6c4e2f90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _reset_research_data() -> None:
    op.execute("DELETE FROM recorded_data")
    op.execute("DELETE FROM measurements")
    op.execute("DELETE FROM designer_models")
    op.execute("DELETE FROM predictor_models")
    op.execute("DELETE FROM experiments")


def _require_empty_experiments_for_downgrade() -> None:
    # Keep the refusal executable both online and in generated offline SQL.
    op.execute(
        """
        DO $caemble$
        BEGIN
            IF EXISTS (SELECT 1 FROM experiments) THEN
                RAISE EXCEPTION
                    'Cannot downgrade while versioned Experiments exist. Export or delete them first.';
            END IF;
        END;
        $caemble$
        """
    )


def _drop_geometry_schema() -> None:
    op.execute("DROP TRIGGER IF EXISTS guard_geometry_namespace_reservation ON users")
    op.execute("DROP TRIGGER IF EXISTS archive_geometry_repositories_before_user_delete ON users")
    op.execute("DROP TABLE IF EXISTS experiment_geometry_imports CASCADE")
    op.execute("DROP TABLE IF EXISTS experiment_geometry_modules CASCADE")
    op.execute("DROP TABLE IF EXISTS experiment_geometry_roots CASCADE")
    op.execute("DROP TABLE IF EXISTS geometry_imports CASCADE")
    op.execute("DROP TABLE IF EXISTS geometry_versions CASCADE")
    op.execute("DROP TABLE IF EXISTS geometry_packages CASCADE")
    op.execute("DROP TABLE IF EXISTS geometry_repositories CASCADE")
    for function in (
        "protect_geometry_import",
        "protect_geometry_version",
        "protect_geometry_package_identity",
        "protect_geometry_repository_identity",
        "validate_geometry_repository_owner_namespace",
        "guard_geometry_namespace_reservation",
        "archive_geometry_repositories_before_user_delete",
    ):
        op.execute(f"DROP FUNCTION IF EXISTS {function}()")


def _install_experiment_guards() -> None:
    op.execute(
        """
        CREATE FUNCTION guard_experiment_namespace_reservation()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF NEW.experiment_namespace = 'caemble' THEN
                RAISE EXCEPTION 'The caemble Experiment namespace is reserved'
                    USING ERRCODE = 'unique_violation';
            END IF;
            IF NEW.experiment_namespace IS NOT NULL AND EXISTS (
                SELECT 1 FROM experiments
                WHERE namespace = NEW.experiment_namespace
                  AND user_id IS DISTINCT FROM NEW.id
            ) THEN
                RAISE EXCEPTION 'Experiment namespace is already reserved'
                    USING ERRCODE = 'unique_violation';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER guard_experiment_namespace_reservation
        BEFORE INSERT OR UPDATE OF experiment_namespace ON users
        FOR EACH ROW
        EXECUTE FUNCTION guard_experiment_namespace_reservation()
        """
    )
    op.execute(
        """
        CREATE FUNCTION validate_experiment_owner_namespace()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM experiments
                WHERE namespace = NEW.namespace
                  AND user_id IS DISTINCT FROM NEW.user_id
            ) OR NOT (
                EXISTS (
                    SELECT 1 FROM users
                    WHERE id = NEW.user_id
                      AND experiment_namespace = NEW.namespace
                )
                OR EXISTS (
                    SELECT 1 FROM experiments
                    WHERE user_id = NEW.user_id
                      AND namespace = NEW.namespace
                )
            ) THEN
                RAISE EXCEPTION 'Experiment namespace must belong to its owner';
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM users
                WHERE id = NEW.user_id
            ) THEN
                RAISE EXCEPTION 'Experiment owner does not exist';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER validate_experiment_owner_namespace
        BEFORE INSERT OR UPDATE OF user_id, namespace ON experiments
        FOR EACH ROW
        EXECUTE FUNCTION validate_experiment_owner_namespace()
        """
    )


def upgrade() -> None:
    # Product decision: the old source/snapshot and derived-data contracts are
    # not representable in bundle v6. Preserve auth users and compatible
    # namespaces, but intentionally reset all operational Geometry and Experiment data.
    _reset_research_data()
    _drop_geometry_schema()

    # `caemble` was valid in the legacy Geometry namespace contract. Official
    # Experiments now reserve it, so preserve the user while clearing only that
    # legacy namespace after the intentionally destructive operational reset.
    op.execute(
        "UPDATE users SET geometry_namespace = NULL "
        "WHERE geometry_namespace = 'caemble'"
    )
    op.execute("ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_geometry_namespace")
    op.execute("ALTER TABLE users DROP CONSTRAINT IF EXISTS ck_users_geometry_namespace_format")
    op.alter_column("users", "geometry_namespace", new_column_name="experiment_namespace")
    op.create_check_constraint(
        op.f("ck_users_experiment_namespace_format"),
        "users",
        "experiment_namespace IS NULL OR (experiment_namespace <> 'caemble' AND "
        "experiment_namespace ~ '^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$')",
    )
    op.create_unique_constraint(
        op.f("uq_users_experiment_namespace"),
        "users",
        ["experiment_namespace"],
    )

    op.drop_index("ix_experiments_parent_id", table_name="experiments")
    op.drop_constraint(
        op.f("fk_experiments_parent_id_experiments"),
        "experiments",
        type_="foreignkey",
    )
    op.drop_column("experiments", "parent_id")
    op.alter_column(
        "experiments",
        "user_id",
        existing_type=sa.UUID(as_uuid=False),
        nullable=False,
    )
    op.add_column("experiments", sa.Column("namespace", sa.Text(), nullable=False))
    op.add_column("experiments", sa.Column("repository_slug", sa.Text(), nullable=False))
    op.add_column("experiments", sa.Column("experiment_key", sa.Text(), nullable=False))
    op.add_column("experiments", sa.Column("version_major", sa.Integer(), nullable=False))
    op.add_column("experiments", sa.Column("version_minor", sa.Integer(), nullable=False))
    op.add_column("experiments", sa.Column("version_patch", sa.Integer(), nullable=False))
    op.create_check_constraint(
        op.f("ck_experiments_namespace_format"),
        "experiments",
        "namespace <> 'caemble' AND "
        "namespace ~ '^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$'",
    )
    op.create_check_constraint(
        op.f("ck_experiments_repository_slug_format"),
        "experiments",
        "repository_slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'",
    )
    op.create_check_constraint(
        op.f("ck_experiments_experiment_key_format"),
        "experiments",
        "experiment_key ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'",
    )
    for component in ("major", "minor", "patch"):
        op.create_check_constraint(
            op.f(f"ck_experiments_version_{component}_nonnegative"),
            "experiments",
            f"version_{component} >= 0",
        )
    op.create_unique_constraint(
        "uq_experiments_coordinate_semver",
        "experiments",
        [
            "namespace",
            "repository_slug",
            "experiment_key",
            "version_major",
            "version_minor",
            "version_patch",
        ],
    )
    op.create_index(
        "ix_experiments_user_id_updated_at",
        "experiments",
        ["user_id", "updated_at"],
        unique=False,
    )
    op.create_index(
        "ix_experiments_repository_versions",
        "experiments",
        [
            "namespace",
            "repository_slug",
            "experiment_key",
            "version_major",
            "version_minor",
            "version_patch",
        ],
        unique=False,
    )
    op.create_index(
        op.f("ix_designer_models_experiment_id"),
        "designer_models",
        ["experiment_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_predictor_models_experiment_id"),
        "predictor_models",
        ["experiment_id"],
        unique=False,
    )

    op.drop_constraint(
        "fk_measurements_experiment_id_experiments",
        "measurements",
        type_="foreignkey",
    )
    op.create_foreign_key(
        "fk_measurements_experiment_id_experiments",
        "measurements",
        "experiments",
        ["experiment_id"],
        ["id"],
        ondelete="CASCADE",
    )
    _install_experiment_guards()


def _create_geometry_schema() -> None:
    def timestamp_columns() -> tuple[sa.Column, sa.Column]:
        return (
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        )
    op.create_table(
        "geometry_repositories",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=True),
        sa.Column("namespace", sa.Text(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        *timestamp_columns(),
        sa.CheckConstraint("slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'", name=op.f("ck_geometry_repositories_slug_format")),
        sa.CheckConstraint("namespace ~ '^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$'", name=op.f("ck_geometry_repositories_namespace_format")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_geometry_repositories_user_id_users"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_geometry_repositories")),
        sa.UniqueConstraint("namespace", "slug", name="uq_geometry_repositories_namespace_slug"),
    )
    op.create_table(
        "geometry_packages",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("repository_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint("name ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'", name=op.f("ck_geometry_packages_name_format")),
        sa.ForeignKeyConstraint(["repository_id"], ["geometry_repositories.id"], name=op.f("fk_geometry_packages_repository_id_geometry_repositories"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_geometry_packages")),
        sa.UniqueConstraint("repository_id", "name", name="uq_geometry_packages_repository_id_name"),
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
        sa.Column("module_format_version", sa.Integer(), server_default=sa.text("4"), nullable=False),
        sa.Column("cad_api_version", sa.Integer(), server_default=sa.text("8"), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        *timestamp_columns(),
        sa.CheckConstraint("version_major >= 0", name=op.f("ck_geometry_versions_version_major_nonnegative")),
        sa.CheckConstraint("version_minor >= 0", name=op.f("ck_geometry_versions_version_minor_nonnegative")),
        sa.CheckConstraint("version_patch >= 0", name=op.f("ck_geometry_versions_version_patch_nonnegative")),
        sa.CheckConstraint("source_hash ~ '^[0-9a-f]{64}$'", name=op.f("ck_geometry_versions_source_hash_sha256")),
        sa.CheckConstraint("module_hash ~ '^[0-9a-f]{64}$'", name=op.f("ck_geometry_versions_module_hash_sha256")),
        sa.CheckConstraint("module_format_version = 4", name=op.f("ck_geometry_versions_module_format_version_supported")),
        sa.CheckConstraint("cad_api_version IN (7, 8)", name=op.f("ck_geometry_versions_cad_api_version_supported")),
        sa.ForeignKeyConstraint(["package_id"], ["geometry_packages.id"], name=op.f("fk_geometry_versions_package_id_geometry_packages"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_geometry_versions")),
        sa.UniqueConstraint("package_id", "version_major", "version_minor", "version_patch", name="uq_geometry_versions_package_id_semver"),
    )
    op.create_index(op.f("ix_geometry_versions_package_id"), "geometry_versions", ["package_id"])
    op.create_table(
        "geometry_imports",
        sa.Column("importer_geometry_version_id", sa.Integer(), nullable=False),
        sa.Column("alias", sa.Text(), nullable=False),
        sa.Column("imported_geometry_version_id", sa.Integer(), nullable=False),
        sa.Column("export_name", sa.Text(), nullable=False),
        sa.CheckConstraint("importer_geometry_version_id <> imported_geometry_version_id", name=op.f("ck_geometry_imports_not_self")),
        sa.CheckConstraint("alias ~ '^[A-Z][A-Za-z0-9_]*$'", name=op.f("ck_geometry_imports_alias_pascal_case")),
        sa.CheckConstraint("export_name ~ '^[A-Z][A-Za-z0-9_]*$'", name=op.f("ck_geometry_imports_export_name_pascal_case")),
        sa.ForeignKeyConstraint(["importer_geometry_version_id"], ["geometry_versions.id"], name=op.f("fk_geometry_imports_importer_geometry_version_id_geometry_versions"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["imported_geometry_version_id"], ["geometry_versions.id"], name=op.f("fk_geometry_imports_imported_geometry_version_id_geometry_versions"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("importer_geometry_version_id", "alias", name=op.f("pk_geometry_imports")),
    )
    op.create_index(op.f("ix_geometry_imports_imported_geometry_version_id"), "geometry_imports", ["imported_geometry_version_id"])
    op.create_table(
        "experiment_geometry_imports",
        sa.Column("experiment_id", sa.Integer(), nullable=False),
        sa.Column("alias", sa.Text(), nullable=False),
        sa.Column("export_name", sa.Text(), nullable=False),
        sa.Column("geometry_version_id", sa.Integer(), nullable=False),
        sa.CheckConstraint("alias ~ '^[A-Z][A-Za-z0-9_]*$'", name=op.f("ck_experiment_geometry_imports_alias_pascal_case")),
        sa.CheckConstraint("export_name ~ '^[A-Z][A-Za-z0-9_]*$'", name=op.f("ck_experiment_geometry_imports_export_name_pascal_case")),
        sa.ForeignKeyConstraint(["experiment_id"], ["experiments.id"], name=op.f("fk_experiment_geometry_imports_experiment_id_experiments"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["geometry_version_id"], ["geometry_versions.id"], name=op.f("fk_experiment_geometry_imports_geometry_version_id_geometry_versions"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("experiment_id", "alias", name=op.f("pk_experiment_geometry_imports")),
    )
    op.create_index(op.f("ix_experiment_geometry_imports_geometry_version_id"), "experiment_geometry_imports", ["geometry_version_id"])
    op.create_table(
        "experiment_geometry_modules",
        sa.Column("experiment_id", sa.Integer(), nullable=False),
        sa.Column("geometry_version_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["experiment_id"], ["experiments.id"], name=op.f("fk_experiment_geometry_modules_experiment_id_experiments"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["geometry_version_id"], ["geometry_versions.id"], name=op.f("fk_experiment_geometry_modules_geometry_version_id_geometry_versions"), ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("experiment_id", "geometry_version_id", name=op.f("pk_experiment_geometry_modules")),
    )
    op.create_index(op.f("ix_experiment_geometry_modules_geometry_version_id"), "experiment_geometry_modules", ["geometry_version_id"])


def _install_geometry_guards() -> None:
    op.execute(
        """
        CREATE FUNCTION archive_geometry_repositories_before_user_delete() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
            UPDATE geometry_repositories SET archived_at = COALESCE(archived_at, now()), updated_at = now()
            WHERE user_id = OLD.id; RETURN OLD;
        END; $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER archive_geometry_repositories_before_user_delete BEFORE DELETE ON users
        FOR EACH ROW EXECUTE FUNCTION archive_geometry_repositories_before_user_delete()
        """
    )
    op.execute(
        """
        CREATE FUNCTION guard_geometry_namespace_reservation() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.geometry_namespace IS NOT NULL AND EXISTS (
                SELECT 1 FROM geometry_repositories WHERE namespace = NEW.geometry_namespace
                AND user_id IS DISTINCT FROM NEW.id
            ) THEN RAISE EXCEPTION 'Geometry namespace is already reserved' USING ERRCODE = 'unique_violation';
            END IF; RETURN NEW;
        END; $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER guard_geometry_namespace_reservation BEFORE INSERT OR UPDATE OF geometry_namespace ON users
        FOR EACH ROW EXECUTE FUNCTION guard_geometry_namespace_reservation()
        """
    )
    op.execute(
        """
        CREATE FUNCTION validate_geometry_repository_owner_namespace() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.user_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM users WHERE id = NEW.user_id AND geometry_namespace = NEW.namespace
            ) THEN RAISE EXCEPTION 'Geometry repository namespace must match its owner'; END IF;
            RETURN NEW;
        END; $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER validate_geometry_repository_owner_namespace BEFORE INSERT OR UPDATE OF user_id, namespace ON geometry_repositories
        FOR EACH ROW EXECUTE FUNCTION validate_geometry_repository_owner_namespace()
        """
    )
    op.execute(
        """
        CREATE FUNCTION protect_geometry_repository_identity() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
            IF TG_OP = 'DELETE' THEN
                IF current_setting('caemble.geometry_delete', true) IS DISTINCT FROM 'on' THEN
                    RAISE EXCEPTION 'Geometry repositories cannot be deleted';
                END IF; RETURN OLD;
            END IF;
            IF OLD.namespace IS DISTINCT FROM NEW.namespace OR OLD.slug IS DISTINCT FROM NEW.slug
               OR (OLD.user_id IS DISTINCT FROM NEW.user_id AND NEW.user_id IS NOT NULL)
               OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL
                   AND current_setting('caemble.geometry_repository_restore', true) IS DISTINCT FROM 'on') THEN
                RAISE EXCEPTION 'Published Geometry repository identity is immutable';
            END IF; RETURN NEW;
        END; $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER protect_geometry_repository_identity BEFORE UPDATE OR DELETE ON geometry_repositories
        FOR EACH ROW EXECUTE FUNCTION protect_geometry_repository_identity()
        """
    )
    for target, identity in (
        ("package", "OLD.repository_id IS DISTINCT FROM NEW.repository_id OR OLD.name IS DISTINCT FROM NEW.name"),
        ("version", "OLD.package_id IS DISTINCT FROM NEW.package_id OR OLD.version_major IS DISTINCT FROM NEW.version_major OR OLD.version_minor IS DISTINCT FROM NEW.version_minor OR OLD.version_patch IS DISTINCT FROM NEW.version_patch OR OLD.description IS DISTINCT FROM NEW.description OR OLD.source IS DISTINCT FROM NEW.source OR OLD.source_hash IS DISTINCT FROM NEW.source_hash OR OLD.module_hash IS DISTINCT FROM NEW.module_hash OR OLD.module_format_version IS DISTINCT FROM NEW.module_format_version OR OLD.cad_api_version IS DISTINCT FROM NEW.cad_api_version OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL)"),
    ):
        table = f"geometry_{target}s"
        function = f"protect_geometry_{target}{'_identity' if target == 'package' else ''}"
        op.execute(
            f"""
            CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
                IF TG_OP = 'DELETE' THEN
                    IF current_setting('caemble.geometry_delete', true) IS DISTINCT FROM 'on' THEN
                        RAISE EXCEPTION 'Geometry {target}s cannot be deleted';
                    END IF; RETURN OLD;
                END IF;
                IF {identity} THEN RAISE EXCEPTION 'Published Geometry {target} content is immutable'; END IF;
                RETURN NEW;
            END; $$
            """
        )
        op.execute(
            f"""
            CREATE TRIGGER {function} BEFORE UPDATE OR DELETE ON {table}
            FOR EACH ROW EXECUTE FUNCTION {function}()
            """
        )
    op.execute(
        """
        CREATE FUNCTION protect_geometry_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF TG_OP = 'DELETE' AND current_setting('caemble.geometry_delete', true) = 'on' THEN RETURN OLD; END IF;
            RAISE EXCEPTION 'Published Geometry imports are immutable';
        END; $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER protect_geometry_import BEFORE UPDATE OR DELETE ON geometry_imports
        FOR EACH ROW EXECUTE FUNCTION protect_geometry_import()
        """
    )


def downgrade() -> None:
    _require_empty_experiments_for_downgrade()
    op.execute("DROP TRIGGER IF EXISTS validate_experiment_owner_namespace ON experiments")
    op.execute("DROP FUNCTION IF EXISTS validate_experiment_owner_namespace()")
    op.execute("DROP TRIGGER IF EXISTS guard_experiment_namespace_reservation ON users")
    op.execute("DROP FUNCTION IF EXISTS guard_experiment_namespace_reservation()")

    op.drop_constraint("fk_measurements_experiment_id_experiments", "measurements", type_="foreignkey")
    op.create_foreign_key(
        "fk_measurements_experiment_id_experiments",
        "measurements",
        "experiments",
        ["experiment_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.drop_index(op.f("ix_predictor_models_experiment_id"), table_name="predictor_models")
    op.drop_index(op.f("ix_designer_models_experiment_id"), table_name="designer_models")
    op.drop_index("ix_experiments_repository_versions", table_name="experiments")
    op.drop_index("ix_experiments_user_id_updated_at", table_name="experiments")
    op.drop_constraint("uq_experiments_coordinate_semver", "experiments", type_="unique")
    for component in ("major", "minor", "patch"):
        op.drop_constraint(op.f(f"ck_experiments_version_{component}_nonnegative"), "experiments", type_="check")
    op.drop_constraint(op.f("ck_experiments_experiment_key_format"), "experiments", type_="check")
    op.drop_constraint(op.f("ck_experiments_repository_slug_format"), "experiments", type_="check")
    op.drop_constraint(op.f("ck_experiments_namespace_format"), "experiments", type_="check")
    for column in ("version_patch", "version_minor", "version_major", "experiment_key", "repository_slug", "namespace"):
        op.drop_column("experiments", column)
    op.add_column("experiments", sa.Column("parent_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        op.f("fk_experiments_parent_id_experiments"),
        "experiments",
        "experiments",
        ["parent_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_experiments_parent_id", "experiments", ["parent_id"])
    op.alter_column("experiments", "user_id", existing_type=sa.UUID(as_uuid=False), nullable=True)

    op.drop_constraint(op.f("uq_users_experiment_namespace"), "users", type_="unique")
    op.drop_constraint(op.f("ck_users_experiment_namespace_format"), "users", type_="check")
    op.alter_column("users", "experiment_namespace", new_column_name="geometry_namespace")
    op.create_check_constraint(
        op.f("ck_users_geometry_namespace_format"),
        "users",
        "geometry_namespace IS NULL OR geometry_namespace ~ '^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$'",
    )
    op.create_unique_constraint(op.f("uq_users_geometry_namespace"), "users", ["geometry_namespace"])
    _create_geometry_schema()
    _install_geometry_guards()
