"""Private S3 object metadata; existing JSON data is retained."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "000000000009"
down_revision = "000000000008"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    if "storage_versions" not in {column["name"] for column in inspector.get_columns("launchers")}:
        op.add_column("launchers", sa.Column("storage_versions", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")))
    # Fresh installations use current ORM metadata in the baseline migration.
    if "storage_objects" in inspector.get_table_names():
        return
    op.create_table(
        "storage_objects",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("experiment_id", sa.Integer(), sa.ForeignKey("experiments.id", ondelete="SET NULL")),
        sa.Column("measurement_id", sa.Integer(), sa.ForeignKey("measurements.id", ondelete="SET NULL")),
        sa.Column("calculation_id", sa.Integer(), sa.ForeignKey("calculations.id", ondelete="SET NULL")),
        sa.Column("calculation_data_id", sa.Integer(), sa.ForeignKey("calculation_data.id", ondelete="SET NULL")),
        sa.Column("job_id", postgresql.UUID(as_uuid=False), sa.ForeignKey("jobs.id", ondelete="SET NULL")),
        sa.Column("attempt", sa.Integer()),
        sa.Column("purpose", sa.Text(), nullable=False),
        sa.Column("manifest", postgresql.JSONB(), nullable=False),
        sa.Column("ready", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("bound", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("deleting", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    for column in ("experiment_id", "measurement_id", "calculation_id", "calculation_data_id", "job_id", "updated_at"):
        op.create_index(f"ix_storage_objects_{column}", "storage_objects", [column])


def downgrade():
    # Never silently discard references to object-backed data.
    connection = op.get_bind()
    if connection.scalar(sa.text("SELECT EXISTS (SELECT 1 FROM storage_objects WHERE bound)")):
        raise RuntimeError("Export or remove object-backed data before downgrading object storage.")
    op.drop_table("storage_objects")
    op.drop_column("launchers", "storage_versions")
