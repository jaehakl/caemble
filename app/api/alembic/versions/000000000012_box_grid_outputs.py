"""Replace derived results with Box Grid Outputs and separate visualizations.

Sources and Measurement inputs survive. This intentionally has no legacy result
adapter and does not contact object storage; durable tombstones drive cleanup.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "000000000012"
down_revision = "000000000011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    if connection.scalar(sa.text("SELECT EXISTS (SELECT 1 FROM jobs WHERE handler_type = 'cae.simulation' AND state IN ('staged', 'queued', 'assigned', 'running', 'finalizing'))")):
        raise RuntimeError("Finish or cancel active CAE jobs before changing the Outputs contract.")
    tables = set(sa.inspect(connection).get_table_names())
    if "measurement_visualizations" not in tables:
        op.create_table(
            "measurement_visualizations",
            sa.Column("measurement_id", sa.Integer(), sa.ForeignKey("measurements.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("task", sa.Text(), primary_key=True),
            sa.Column("data", postgresql.JSONB(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )
    if "job_visualizations" not in tables:
        op.create_table(
            "job_visualizations",
            sa.Column("job_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("jobs.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("attempt_count", sa.Integer(), primary_key=True),
            sa.Column("sequence", sa.Integer(), primary_key=True),
            sa.Column("task", sa.Text(), nullable=False),
            sa.Column("payload", postgresql.JSONB(), nullable=False),
            sa.UniqueConstraint("job_id", "attempt_count", "task", name="uq_job_visualizations_task"),
        )
    op.execute("UPDATE storage_objects SET deleting = true, bound = false, updated_at = CURRENT_TIMESTAMP - INTERVAL '25 hours' WHERE purpose IN ('record', 'visualization', 'calculation', 'layout')")
    op.execute("DELETE FROM calculation_data")
    op.execute("DELETE FROM calculation_experiment_records")
    op.execute("DELETE FROM recorded_data")
    op.execute("DELETE FROM measurement_visualizations")
    op.execute("DELETE FROM experiment_records")
    op.execute("UPDATE experiments SET result_contracts = '{}'::jsonb")
    op.execute("UPDATE measurements SET recorded_at = NULL")
    op.execute("UPDATE calculations SET contract_status = 'needs_preflight', output_layout = NULL, preflight_measurement_id = NULL, revision = revision + 1")
    op.execute("DELETE FROM job_records WHERE job_id IN (SELECT id FROM jobs WHERE handler_type = 'cae.simulation')")
    op.execute("DELETE FROM job_visualizations WHERE job_id IN (SELECT id FROM jobs WHERE handler_type = 'cae.simulation')")
    op.execute("""
        UPDATE jobs
        SET artifact_metadata = artifact_metadata - 'recorded_data' - 'visualizations' - 'execution_trace'
        WHERE handler_type = 'cae.simulation'
          AND jsonb_typeof(artifact_metadata) = 'object'
    """)


def downgrade() -> None:
    raise RuntimeError("Discarded legacy results cannot be restored. Restore a database backup to recover the previous contract.")
