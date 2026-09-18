"""Version-scoped initial Measurement and Viewer defaults."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "000000000015"
down_revision = "000000000014"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("experiments")}
    if "initial_measurement_id" not in columns:
        op.add_column("experiments", sa.Column("initial_measurement_id", sa.Integer(), nullable=True))
    if "viewer_defaults" not in columns:
        op.add_column("experiments", sa.Column("viewer_defaults", postgresql.JSONB(), nullable=True))
    if "fk_experiment_initial_measurement" not in {key["name"] for key in inspector.get_foreign_keys("experiments")}:
        op.create_foreign_key("fk_experiment_initial_measurement", "experiments", "measurements",
                              ["initial_measurement_id"], ["id"], ondelete="SET NULL")


def downgrade():
    op.drop_constraint("fk_experiment_initial_measurement", "experiments", type_="foreignkey")
    op.drop_column("experiments", "viewer_defaults")
    op.drop_column("experiments", "initial_measurement_id")
