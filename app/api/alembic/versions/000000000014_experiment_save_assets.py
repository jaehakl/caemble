"""Persist thumbnails, save receipts and promoted Preflight snapshots."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "000000000014"
down_revision = "000000000013"
branch_labels = None
depends_on = None


def upgrade():
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "experiment_thumbnails" not in tables:
        op.create_table("experiment_thumbnails",
            sa.Column("experiment_id", sa.Integer(), sa.ForeignKey("experiments.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("data", sa.LargeBinary(), nullable=False), sa.Column("sha256", sa.Text(), nullable=False))
    if "experiment_save_receipts" not in tables:
        op.create_table("experiment_save_receipts",
            sa.Column("user_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("request_id", postgresql.UUID(as_uuid=False), primary_key=True),
            sa.Column("payload_hash", sa.Text(), nullable=False), sa.Column("response", postgresql.JSONB(), nullable=False))
    if "measurement_snapshots" not in tables:
        op.create_table("measurement_snapshots",
            sa.Column("measurement_id", sa.Integer(), sa.ForeignKey("measurements.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("artifact", postgresql.JSONB(), nullable=False),
            sa.Column("metadata_json", postgresql.JSONB(), nullable=False),
            sa.Column("execution_trace", postgresql.JSONB(), nullable=False))


def downgrade():
    op.drop_table("measurement_snapshots")
    op.drop_table("experiment_save_receipts")
    op.drop_table("experiment_thumbnails")
