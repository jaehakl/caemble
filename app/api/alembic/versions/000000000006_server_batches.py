"""Add durable server-master jobs and CAE batches."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "000000000006"
down_revision = "000000000005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    uuid = postgresql.UUID(as_uuid=False)
    tables = set(sa.inspect(bind).get_table_names())
    if "job_batches" not in tables:
        op.create_table(
            "job_batches",
            sa.Column("id", uuid, primary_key=True),
            sa.Column(
                "user_id", uuid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
            ),
            sa.Column("request_id", uuid, nullable=False),
            sa.Column("request_hash", sa.Text(), nullable=False),
            sa.Column("total", sa.BigInteger(), nullable=False),
            *[
                sa.Column(name, sa.BigInteger(), nullable=False, server_default="0")
                for name in (
                    "created_count",
                    "succeeded",
                    "failed",
                    "cancelled",
                    "last_event_id",
                    "read_event_id",
                )
            ],
            sa.Column("state", sa.Text(), nullable=False, server_default="queued"),
            sa.Column(
                "generation_stopped", sa.Boolean(), nullable=False, server_default=sa.text("false")
            ),
            sa.Column("finished_at", sa.DateTime(timezone=True)),
            sa.Column("last_prepared_at", sa.DateTime(timezone=True)),
            *[
                sa.Column(
                    name, sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
                )
                for name in ("created_at", "updated_at")
            ],
            sa.UniqueConstraint("user_id", "request_id", name="uq_job_batches_request"),
        )
        op.create_index("ix_job_batches_user_id", "job_batches", ["user_id"])
    columns = {column["name"] for column in sa.inspect(bind).get_columns("jobs")}
    if "job_mode" not in columns:
        op.add_column(
            "jobs", sa.Column("job_mode", sa.Text(), nullable=False, server_default="webrtc")
        )
        op.add_column(
            "jobs", sa.Column("batch_id", uuid, sa.ForeignKey("job_batches.id", ondelete="CASCADE"))
        )
        op.add_column("jobs", sa.Column("item_index", sa.BigInteger()))
        op.add_column("jobs", sa.Column("input", postgresql.JSONB()))
        op.add_column("jobs", sa.Column("worker_token_hash", sa.Text()))
        op.add_column("jobs", sa.Column("cleaned_at", sa.DateTime(timezone=True)))
        op.create_index("ix_jobs_batch_id", "jobs", ["batch_id"])
        op.create_unique_constraint("uq_jobs_batch_item", "jobs", ["batch_id", "item_index"])
    if "job_modes" not in {column["name"] for column in sa.inspect(bind).get_columns("launchers")}:
        op.add_column(
            "launchers",
            sa.Column(
                "job_modes",
                postgresql.JSONB(),
                nullable=False,
                server_default=sa.text("'{}'::jsonb"),
            ),
        )
    if "job_id" not in {column["name"] for column in sa.inspect(bind).get_columns("measurements")}:
        op.add_column(
            "measurements", sa.Column("job_id", uuid, sa.ForeignKey("jobs.id", ondelete="SET NULL"))
        )
        op.create_unique_constraint("uq_measurements_job_id", "measurements", ["job_id"])
    if "cae_batches" not in tables:
        op.create_table(
            "cae_batches",
            sa.Column(
                "batch_id",
                uuid,
                sa.ForeignKey("job_batches.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column(
                "experiment_id",
                sa.Integer(),
                sa.ForeignKey("experiments.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("spec", postgresql.JSONB(), nullable=False),
        )
        op.create_index("ix_cae_batches_experiment_id", "cae_batches", ["experiment_id"])
    if "job_events" not in tables:
        op.create_table(
            "job_events",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column(
                "user_id", uuid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False
            ),
            sa.Column(
                "batch_id",
                uuid,
                sa.ForeignKey("job_batches.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("job_id", uuid, sa.ForeignKey("jobs.id", ondelete="SET NULL")),
            sa.Column("attempt_count", sa.Integer()),
            sa.Column("type", sa.Text(), nullable=False),
            sa.Column("payload", postgresql.JSONB(), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )
        op.create_index("ix_job_events_user_cursor", "job_events", ["user_id", "id"])
        op.create_index("ix_job_events_batch_id", "job_events", ["batch_id"])
    if "job_records" not in tables:
        op.create_table(
            "job_records",
            sa.Column(
                "job_id", uuid, sa.ForeignKey("jobs.id", ondelete="CASCADE"), primary_key=True
            ),
            sa.Column("attempt_count", sa.Integer(), primary_key=True),
            sa.Column("sequence", sa.Integer(), primary_key=True),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("payload", postgresql.JSONB(), nullable=False),
            sa.UniqueConstraint("job_id", "attempt_count", "name", name="uq_job_records_name"),
        )


def downgrade() -> None:
    op.drop_table("job_records")
    op.drop_table("job_events")
    op.drop_table("cae_batches")
    op.drop_column("measurements", "job_id")
    op.drop_column("launchers", "job_modes")
    for name in ("cleaned_at", "worker_token_hash", "input", "item_index", "batch_id", "job_mode"):
        op.drop_column("jobs", name)
    op.drop_table("job_batches")
