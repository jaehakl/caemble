"""Remove source declarations; retain Experiment preflight and source identity."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "000000000018"
down_revision = "000000000017"
branch_labels = None
depends_on = None


def upgrade():
    # Fresh installs create the current ORM schema in the initial migration.
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("calculation_sources")}
    for column in ["input_contract", "output_contract", "contract_hash"]:
        if column in columns:
            op.drop_column("calculation_sources", column)


def downgrade():
    # Removed declarations are not reconstructed from source comments.
    op.add_column("calculation_sources", sa.Column("input_contract", JSONB(), nullable=True))
    op.add_column("calculation_sources", sa.Column("output_contract", JSONB(), nullable=True))
    op.add_column("calculation_sources", sa.Column("contract_hash", sa.Text(), nullable=True))
