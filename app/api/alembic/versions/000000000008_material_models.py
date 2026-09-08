"""Reset the retired Experiment generation and adopt explicit Material snapshots.

The reset is deliberate: legacy Material name lookups cannot be interpreted by
the model-input ABI. Deploy only after exporting any required old experiments
and draining CAE execution. Account and unrelated GPStation data are retained.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "000000000008"
down_revision = "000000000007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    # The baseline creates the current metadata on a fresh installation. Only
    # databases with the retired column contain an old Experiment generation.
    columns = {column["name"] for column in sa.inspect(bind).get_columns("measurements")}
    if "material_parameters" in columns:
        op.execute("LOCK TABLE experiments, measurements, jobs, job_batches, cae_batches IN ACCESS EXCLUSIVE MODE")
        affected_jobs = """(slave_app_id = 'cae' OR handler_type LIKE 'cae.%'
            OR batch_id IN (SELECT batch_id FROM cae_batches)
            OR id IN (SELECT job_id FROM measurements WHERE job_id IS NOT NULL))"""
        active = bind.scalar(sa.text(f"""SELECT count(*) FROM jobs WHERE {affected_jobs}
            AND state NOT IN ('succeeded', 'failed', 'cancelled', 'killed', 'finished', 'completed')"""))
        active_batches = bind.scalar(sa.text("""SELECT count(*) FROM job_batches
            WHERE id IN (SELECT batch_id FROM cae_batches)
            AND state NOT IN ('completed', 'cancelled', 'failed')"""))
        if active or active_batches:
            raise RuntimeError("Drain or cancel all CAE jobs and uploads before the Material Model reset. Run deployment/update.sh.")
        # Capture affected batch IDs before deleting their jobs and experiments.
        op.execute(f"""CREATE TEMPORARY TABLE material_model_reset_batches ON COMMIT DROP AS
            SELECT batch_id AS id FROM cae_batches UNION
            SELECT batch_id AS id FROM jobs WHERE {affected_jobs} AND batch_id IS NOT NULL""")
        op.execute(f"DELETE FROM jobs WHERE {affected_jobs}")
        op.execute("DELETE FROM cae_batches")
        op.execute("""DELETE FROM job_batches WHERE id IN (SELECT id FROM material_model_reset_batches)
            AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.batch_id = job_batches.id)""")
        op.execute("DELETE FROM experiments")
        op.drop_column("measurements", "material_parameters")
        if "material_snapshot" not in columns:
            op.add_column("measurements", sa.Column("material_snapshot", postgresql.JSONB(), nullable=False))
    for table in ("material_parameter_qualifiers", "material_parameters", "material_names", "materials"):
        if table in tables:
            op.drop_table(table)


def downgrade() -> None:
    raise RuntimeError("The Material Model generation reset cannot restore removed inputs. Restore an exported backup instead.")
