"""Separate durable Prediction training from inference sessions."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "000000000026"
down_revision = "000000000025"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("prediction_training_runs",
        sa.Column("operation_id", UUID(as_uuid=False), sa.ForeignKey("prediction_operations.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("job_id", UUID(as_uuid=False), sa.ForeignKey("jobs.id", ondelete="RESTRICT"), unique=True),
        sa.Column("dataset_id", UUID(as_uuid=False), sa.ForeignKey("prediction_datasets.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("dataset_revision", sa.Integer(), nullable=False),
        sa.Column("source_kind", sa.Text(), nullable=False),
        sa.Column("source_replica_id", UUID(as_uuid=False), sa.ForeignKey("prediction_replicas.id", ondelete="RESTRICT")),
        sa.Column("pin_id", UUID(as_uuid=False), nullable=False),
        sa.Column("resources", JSONB(), nullable=False),
        sa.Column("retry_requests", JSONB(), nullable=False),
        sa.Column("preflight_request_id", UUID(as_uuid=False)),
        sa.Column("preflight_expires_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.create_index("ix_prediction_training_runs_dataset_id", "prediction_training_runs", ["dataset_id"])


def downgrade():
    op.drop_table("prediction_training_runs")
