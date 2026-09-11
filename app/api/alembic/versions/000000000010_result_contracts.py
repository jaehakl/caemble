"""Freeze semantic result contracts without changing historical records."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "000000000010"
down_revision = "000000000009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "result_contracts" in {column["name"] for column in sa.inspect(op.get_bind()).get_columns("experiments")}:
        return
    op.add_column("experiments", sa.Column("result_contracts", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("experiments", "result_contracts")
