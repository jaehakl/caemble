"""Allow temporary CAE batches without a saved Experiment."""
from alembic import op
import sqlalchemy as sa

revision = "000000000011"
down_revision = "000000000010"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column("cae_batches", "experiment_id", existing_type=sa.Integer(), nullable=True)


def downgrade():
    # Do not delete temporary runs implicitly to satisfy the old constraint.
    op.alter_column("cae_batches", "experiment_id", existing_type=sa.Integer(), nullable=False)
