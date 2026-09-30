"""Persist Study definitions, Trials, and fenced stage submission history."""
from alembic import op
import sqlalchemy as sa

revision = "000000000020"
down_revision = "000000000019"
branch_labels = None
depends_on = None


def upgrade():
    from optimization.db import StageSubmission, Study, Trial
    for table in (Study.__table__, Trial.__table__, StageSubmission.__table__):
        table.create(op.get_bind(), checkfirst=True)


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM cae_studies)")):
        raise RuntimeError("Delete retained Studies before downgrading parameter optimization.")
    for table in ("cae_stage_submissions", "cae_trials", "cae_studies"):
        op.drop_table(table)
