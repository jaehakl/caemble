"""use source-based multi-export Geometry modules

Revision ID: b31f7d9a4c20
Revises: 8d4e2f6a1b30
Create Date: 2026-08-13
"""

from collections.abc import Sequence
import hashlib
import json

import sqlalchemy as sa
from alembic import op


revision: str = "b31f7d9a4c20"
down_revision: str | None = "8d4e2f6a1b30"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _discard_geometry_experiments() -> None:
    op.execute(
        """
        CREATE TEMPORARY TABLE discarded_source_geometry_experiments
        ON COMMIT DROP
        AS
        SELECT DISTINCT experiments.id
        FROM experiments
        WHERE EXISTS (
            SELECT 1 FROM experiment_geometry_modules
            WHERE experiment_geometry_modules.experiment_id = experiments.id
        )
        OR EXISTS (
            SELECT 1 FROM experiment_geometry_roots
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
        "DELETE FROM measurements WHERE experiment_id IN "
        "(SELECT id FROM discarded_source_geometry_experiments)"
    )
    op.execute(
        "DELETE FROM experiments WHERE id IN "
        "(SELECT id FROM discarded_source_geometry_experiments)"
    )


def _discard_all_geometry() -> None:
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


def _store_bundle(experiment_id: int, bundle: dict) -> None:
    canonical = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    op.get_bind().execute(
        sa.text(
            "UPDATE experiments SET source_bundle = CAST(:bundle AS jsonb), "
            "source_hash = :source_hash WHERE id = :experiment_id"
        ),
        {
            "bundle": json.dumps(bundle, ensure_ascii=False),
            "source_hash": digest,
            "experiment_id": experiment_id,
        },
    )


def _upgrade_empty_experiments() -> None:
    rows = op.get_bind().execute(sa.text("SELECT id, source_bundle FROM experiments")).mappings()
    for row in rows:
        bundle = dict(row["source_bundle"])
        files = dict(bundle.get("files") or {})
        files["geometry.tsx"] = "export {}\n"
        bundle = {
            "formatVersion": 4,
            "files": files,
            "geometrySnapshot": {"schemaVersion": 2, "entryImports": [], "modules": []},
        }
        _store_bundle(row["id"], bundle)


def _downgrade_experiments() -> None:
    rows = list(op.get_bind().execute(sa.text("SELECT id, source_bundle FROM experiments")).mappings())
    delete_ids: list[int] = []
    for row in rows:
        bundle = dict(row["source_bundle"])
        files = dict(bundle.get("files") or {})
        snapshot = bundle.get("geometrySnapshot") or {}
        if (
            bundle.get("formatVersion") != 4
            or files.get("geometry.tsx") != "export {}\n"
            or snapshot != {"schemaVersion": 2, "entryImports": [], "modules": []}
        ):
            delete_ids.append(row["id"])
            continue
        files.pop("geometry.tsx", None)
        _store_bundle(row["id"], {"formatVersion": 2, "files": files})
    if delete_ids:
        op.get_bind().execute(
            sa.text("DELETE FROM measurements WHERE experiment_id = ANY(:ids)"),
            {"ids": delete_ids},
        )
        op.get_bind().execute(
            sa.text("DELETE FROM experiments WHERE id = ANY(:ids)"),
            {"ids": delete_ids},
        )


def _create_v3_import_tables() -> None:
    op.drop_table("geometry_imports")
    op.create_table(
        "geometry_imports",
        sa.Column("importer_geometry_version_id", sa.Integer(), nullable=False),
        sa.Column("alias", sa.Text(), nullable=False),
        sa.Column("imported_geometry_version_id", sa.Integer(), nullable=False),
        sa.Column("export_name", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "importer_geometry_version_id <> imported_geometry_version_id",
            name=op.f("ck_geometry_imports_not_self"),
        ),
        sa.CheckConstraint(
            "alias ~ '^[A-Z][A-Za-z0-9_]*$'",
            name=op.f("ck_geometry_imports_alias_pascal_case"),
        ),
        sa.CheckConstraint(
            "export_name ~ '^[A-Z][A-Za-z0-9_]*$'",
            name=op.f("ck_geometry_imports_export_name_pascal_case"),
        ),
        sa.ForeignKeyConstraint(
            ["importer_geometry_version_id"],
            ["geometry_versions.id"],
            name=op.f("fk_geometry_imports_importer_geometry_version_id_geometry_versions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["imported_geometry_version_id"],
            ["geometry_versions.id"],
            name=op.f("fk_geometry_imports_imported_geometry_version_id_geometry_versions"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint(
            "importer_geometry_version_id",
            "alias",
            name=op.f("pk_geometry_imports"),
        ),
    )
    op.create_index(
        op.f("ix_geometry_imports_imported_geometry_version_id"),
        "geometry_imports",
        ["imported_geometry_version_id"],
        unique=False,
    )
    op.execute(
        """
        CREATE TRIGGER protect_geometry_import
        BEFORE UPDATE OR DELETE ON geometry_imports
        FOR EACH ROW
        EXECUTE FUNCTION protect_geometry_import()
        """
    )
    op.drop_table("experiment_geometry_roots")
    op.create_table(
        "experiment_geometry_imports",
        sa.Column("experiment_id", sa.Integer(), nullable=False),
        sa.Column("alias", sa.Text(), nullable=False),
        sa.Column("export_name", sa.Text(), nullable=False),
        sa.Column("geometry_version_id", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "alias ~ '^[A-Z][A-Za-z0-9_]*$'",
            name=op.f("ck_experiment_geometry_imports_alias_pascal_case"),
        ),
        sa.CheckConstraint(
            "export_name ~ '^[A-Z][A-Za-z0-9_]*$'",
            name=op.f("ck_experiment_geometry_imports_export_name_pascal_case"),
        ),
        sa.ForeignKeyConstraint(
            ["experiment_id"], ["experiments.id"],
            name=op.f("fk_experiment_geometry_imports_experiment_id_experiments"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["geometry_version_id"], ["geometry_versions.id"],
            name=op.f("fk_experiment_geometry_imports_geometry_version_id_geometry_versions"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint(
            "experiment_id", "alias", name=op.f("pk_experiment_geometry_imports")
        ),
    )
    op.create_index(
        op.f("ix_experiment_geometry_imports_geometry_version_id"),
        "experiment_geometry_imports",
        ["geometry_version_id"],
        unique=False,
    )


def _create_v2_import_tables() -> None:
    op.drop_index(
        op.f("ix_experiment_geometry_imports_geometry_version_id"),
        table_name="experiment_geometry_imports",
    )
    op.drop_table("experiment_geometry_imports")
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
            ["experiment_id"], ["experiments.id"],
            name=op.f("fk_experiment_geometry_roots_experiment_id_experiments"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["geometry_version_id"], ["geometry_versions.id"],
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
    op.drop_table("geometry_imports")
    op.create_table(
        "geometry_imports",
        sa.Column("importer_geometry_version_id", sa.Integer(), nullable=False),
        sa.Column("imported_geometry_version_id", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "importer_geometry_version_id <> imported_geometry_version_id",
            name=op.f("ck_geometry_imports_not_self"),
        ),
        sa.ForeignKeyConstraint(
            ["importer_geometry_version_id"], ["geometry_versions.id"],
            name=op.f("fk_geometry_imports_importer_geometry_version_id_geometry_versions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["imported_geometry_version_id"], ["geometry_versions.id"],
            name=op.f("fk_geometry_imports_imported_geometry_version_id_geometry_versions"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint(
            "importer_geometry_version_id", "imported_geometry_version_id",
            name=op.f("pk_geometry_imports"),
        ),
    )
    op.execute(
        """
        CREATE TRIGGER protect_geometry_import
        BEFORE UPDATE OR DELETE ON geometry_imports
        FOR EACH ROW
        EXECUTE FUNCTION protect_geometry_import()
        """
    )


def upgrade() -> None:
    _discard_geometry_experiments()
    _discard_all_geometry()
    _create_v3_import_tables()
    _set_module_format(3)
    _upgrade_empty_experiments()


def downgrade() -> None:
    _downgrade_experiments()
    _discard_all_geometry()
    _create_v2_import_tables()
    _set_module_format(2)
