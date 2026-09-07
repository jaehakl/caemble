"""Stage client artifacts, add Calculation CAS, retire internal Agent credentials."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "000000000007"
down_revision = "000000000006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "job_batches" in tables and bind.scalar(sa.text(
        "SELECT count(*) FROM job_batches WHERE state IN ('queued', 'running')"
    )):
        raise RuntimeError("Drain active CAE batches before migrating to client-built artifacts. Run deployment/update.sh.")
    if "cae_upload_chunks" not in tables:
        op.create_table(
            "cae_upload_chunks",
            sa.Column("job_id", postgresql.UUID(as_uuid=False),
                      sa.ForeignKey("jobs.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("chunk_index", sa.Integer(), primary_key=True),
            sa.Column("sha256", sa.Text(), nullable=False),
            sa.Column("data", sa.LargeBinary(), nullable=False),
        )
    columns = {column["name"] for column in sa.inspect(bind).get_columns("jobs")}
    if "artifact_metadata" not in columns:
        op.add_column("jobs", sa.Column("artifact_metadata", postgresql.JSONB()))
    columns = {column["name"] for column in sa.inspect(bind).get_columns("job_batches")}
    if "uploaded_count" not in columns:
        op.add_column("job_batches", sa.Column("uploaded_count", sa.BigInteger(), nullable=False, server_default="0"))
    if "last_prepared_at" in columns and "last_dispatched_at" not in columns:
        op.alter_column("job_batches", "last_prepared_at", new_column_name="last_dispatched_at")
    elif "last_dispatched_at" not in columns:
        op.add_column("job_batches", sa.Column("last_dispatched_at", sa.DateTime(timezone=True)))
    columns = {column["name"] for column in sa.inspect(bind).get_columns("calculations")}
    if "revision" not in columns:
        op.add_column("calculations", sa.Column("revision", sa.Integer(), nullable=False, server_default="1"))
    op.execute("DROP TABLE IF EXISTS ai_provider_credentials")


def downgrade() -> None:
    op.drop_column("calculations", "revision")
    op.alter_column("job_batches", "last_dispatched_at", new_column_name="last_prepared_at")
    op.drop_column("job_batches", "uploaded_count")
    op.drop_column("jobs", "artifact_metadata")
    op.drop_table("cae_upload_chunks")
    # Removed provider secrets are intentionally not recoverable by a downgrade.
