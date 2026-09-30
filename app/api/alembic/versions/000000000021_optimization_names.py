"""Rename Optimization contracts without replacing retained execution history."""
from alembic import op
import sqlalchemy as sa

revision = "000000000021"
down_revision = "000000000020"
branch_labels = None
depends_on = None


def rename_metadata(old: str, new: str) -> None:
    # These are application-owned top-level fields, never authored source/Vars.
    fields = (
        ("jobs", "artifact_metadata", f"{old}_id", f"{new}_id"),
        ("jobs", "artifact_metadata", f"{old}_cancel_reason", f"{new}_cancel_reason"),
        ("cae_batches", "spec", f"{old}_id", f"{new}_id"),
        ("job_events", "payload", f"{old}_id", f"{new}_id"),
        ("cae_stage_submissions", "result", f"{old}_id", f"{new}_id"),
    )
    connection = op.get_bind()
    for table, column, previous, replacement in fields:
        if connection.scalar(sa.text(
            f"SELECT EXISTS (SELECT 1 FROM {table} WHERE {column} ? '{previous}' "
            f"AND {column} ? '{replacement}' "
            f"AND {column}->'{previous}' IS DISTINCT FROM {column}->'{replacement}')"
        )):
            raise RuntimeError(f"Conflicting {previous}/{replacement} in {table}.{column}; migration aborted.")
        connection.execute(sa.text(
            f"UPDATE {table} SET {column} = ({column} - '{previous}') "
            f"|| jsonb_build_object('{replacement}', {column}->'{previous}') "
            f"WHERE {column} ? '{previous}'"
        ))


def rename_schema(old: str, new: str) -> None:
    tables = {"study": "cae_studies", "optimization": "cae_optimizations"}
    old_table, new_table = tables[old], tables[new]
    op.rename_table(old_table, new_table)
    op.alter_column("cae_trials", f"{old}_id", new_column_name=f"{new}_id")
    for previous, replacement in (
        (f"pk_{old_table}", f"pk_{new_table}"),
        (f"uq_{old_table}_request", f"uq_{new_table}_request"),
        (f"fk_{old_table}_user_id_users", f"fk_{new_table}_user_id_users"),
        (f"fk_{old_table}_experiment_id_experiments", f"fk_{new_table}_experiment_id_experiments"),
    ):
        op.execute(f"ALTER TABLE {new_table} RENAME CONSTRAINT {previous} TO {replacement}")
    op.execute(f"ALTER TABLE cae_trials RENAME CONSTRAINT fk_cae_trials_{old}_id_{old_table} "
               f"TO fk_cae_trials_{new}_id_{new_table}")
    for previous, replacement in (
        (f"ix_{old_table}_user_id", f"ix_{new_table}_user_id"),
        (f"ix_{old_table}_experiment_id", f"ix_{new_table}_experiment_id"),
        (f"ix_cae_trials_{old}_id", f"ix_cae_trials_{new}_id"),
    ):
        op.execute(f"ALTER INDEX {previous} RENAME TO {replacement}")


def upgrade():
    # Deploy after stopping API writers; the migration is one PostgreSQL transaction.
    op.execute("LOCK TABLE cae_studies, cae_trials, cae_stage_submissions, jobs, cae_batches, job_events IN ACCESS EXCLUSIVE MODE")
    rename_metadata("study", "optimization")
    rename_schema("study", "optimization")


def downgrade():
    op.execute("LOCK TABLE cae_optimizations, cae_trials, cae_stage_submissions, jobs, cae_batches, job_events IN ACCESS EXCLUSIVE MODE")
    rename_metadata("optimization", "study")
    rename_schema("optimization", "study")
