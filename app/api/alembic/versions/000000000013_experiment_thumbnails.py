"""Add optional Experiment thumbnail URLs."""
from alembic import op
import sqlalchemy as sa

revision = "000000000013"
down_revision = "000000000012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("experiments")}
    if "thumbnail_url" not in columns:
        op.add_column("experiments", sa.Column("thumbnail_url", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("experiments", "thumbnail_url")
