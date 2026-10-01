"""Keep local-asset jobs on the explicitly selected launcher."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "000000000022"
down_revision = "000000000021"
branch_labels = None
depends_on = None


def upgrade():
    # No SET NULL foreign key: deleting the target must not allow another launcher.
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("jobs")}
    if "target_launcher_id" not in existing:
        op.add_column("jobs", sa.Column("target_launcher_id", postgresql.UUID(as_uuid=False), nullable=True))


def downgrade():
    op.drop_column("jobs", "target_launcher_id")
