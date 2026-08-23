"""add multi Experiment namespaces

Revision ID: e4a1b7c9d2f0
Revises: c5e2a9d7f410
Create Date: 2026-08-24
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "e4a1b7c9d2f0"
down_revision: str | Sequence[str] | None = "c5e2a9d7f410"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "experiment_namespaces",
        sa.Column("namespace", sa.Text(), nullable=False),
        sa.Column("user_id", sa.UUID(as_uuid=False), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_experiment_namespaces_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("namespace", name=op.f("pk_experiment_namespaces")),
        sa.UniqueConstraint(
            "namespace",
            "user_id",
            name="uq_experiment_namespaces_namespace_user_id",
        ),
    )
    op.create_index(
        op.f("ix_experiment_namespaces_user_id"),
        "experiment_namespaces",
        ["user_id"],
        unique=False,
    )
    op.execute(
        """
        INSERT INTO experiment_namespaces (namespace, user_id)
        SELECT namespace, min(user_id::text)::uuid
        FROM experiments
        GROUP BY namespace
        HAVING count(DISTINCT user_id) = 1
        """
    )
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM experiments
                GROUP BY namespace
                HAVING count(DISTINCT user_id) > 1
            ) THEN
                RAISE EXCEPTION 'Cannot migrate Experiment namespace owned by multiple users';
            END IF;
        END;
        $$
        """
    )
    op.execute("DROP TRIGGER IF EXISTS validate_experiment_owner_namespace ON experiments")
    op.execute("DROP FUNCTION IF EXISTS validate_experiment_owner_namespace()")
    op.execute("DROP TRIGGER IF EXISTS guard_experiment_namespace_reservation ON users")
    op.execute("DROP FUNCTION IF EXISTS guard_experiment_namespace_reservation()")
    op.create_foreign_key(
        "fk_experiments_namespace_user_id_experiment_namespaces",
        "experiments",
        "experiment_namespaces",
        ["namespace", "user_id"],
        ["namespace", "user_id"],
        ondelete="RESTRICT",
    )
    op.drop_constraint(op.f("uq_users_experiment_namespace"), "users", type_="unique")
    op.drop_constraint(op.f("ck_users_experiment_namespace_format"), "users", type_="check")
    op.drop_column("users", "experiment_namespace")


def downgrade() -> None:
    op.add_column("users", sa.Column("experiment_namespace", sa.Text(), nullable=True))
    op.execute(
        """
        UPDATE users
        SET experiment_namespace = selected.namespace
        FROM (
            SELECT user_id, min(namespace) AS namespace
            FROM experiment_namespaces
            GROUP BY user_id
        ) AS selected
        WHERE users.id = selected.user_id
        """
    )
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
    op.drop_constraint(
        "fk_experiments_namespace_user_id_experiment_namespaces",
        "experiments",
        type_="foreignkey",
    )
    op.drop_index(op.f("ix_experiment_namespaces_user_id"), table_name="experiment_namespaces")
    op.drop_table("experiment_namespaces")
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
            IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id) THEN
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
