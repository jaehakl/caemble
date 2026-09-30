"""Persist Study definitions, Trials, and fenced stage submission history."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "000000000020"
down_revision = "000000000019"
branch_labels = None
depends_on = None


def timestamps():
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    ]


def upgrade():
    # Historical DDL must not follow the renamed live Optimization ORM.
    op.create_table(
        "cae_studies",
        sa.Column("id", UUID(as_uuid=False), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=False), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("experiment_id", sa.Integer(), sa.ForeignKey("experiments.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("request_id", UUID(as_uuid=False), nullable=False),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False, server_default="running"),
        sa.Column("pause_reason", sa.Text()),
        sa.Column("definition", JSONB(), nullable=False),
        sa.Column("settings", JSONB(), nullable=False),
        sa.Column("optimizer_state", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("best_trial_id", UUID(as_uuid=False)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        *timestamps(),
        sa.UniqueConstraint("user_id", "request_id", name="uq_cae_studies_request"),
    )
    op.create_index("ix_cae_studies_user_id", "cae_studies", ["user_id"])
    op.create_index("ix_cae_studies_experiment_id", "cae_studies", ["experiment_id"])
    op.create_table(
        "cae_trials",
        sa.Column("id", UUID(as_uuid=False), primary_key=True),
        sa.Column("study_id", UUID(as_uuid=False), sa.ForeignKey("cae_studies.id", ondelete="CASCADE"), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("round_index", sa.Integer(), nullable=False),
        sa.Column("variables", JSONB(), nullable=False),
        sa.Column("fingerprint", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("next_stage", sa.Text(), nullable=False, server_default="build"),
        sa.Column("measurement_id", sa.Integer(), sa.ForeignKey("measurements.id", ondelete="RESTRICT")),
        sa.Column("result", JSONB()),
        sa.Column("error", JSONB()),
        sa.Column("manual_retry_requested", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("retry_request_id", UUID(as_uuid=False)),
        sa.Column("retry_requests", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        *timestamps(),
        sa.UniqueConstraint("study_id", "ordinal", name="uq_cae_trials_ordinal"),
        sa.UniqueConstraint("study_id", "fingerprint", name="uq_cae_trials_fingerprint"),
    )
    op.create_index("ix_cae_trials_study_id", "cae_trials", ["study_id"])
    op.create_index("ix_cae_trials_measurement_id", "cae_trials", ["measurement_id"])
    op.create_table(
        "cae_stage_submissions",
        sa.Column("id", UUID(as_uuid=False), primary_key=True),
        sa.Column("trial_id", UUID(as_uuid=False), sa.ForeignKey("cae_trials.id", ondelete="CASCADE"), nullable=False),
        sa.Column("stage", sa.Text(), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("batch_id", UUID(as_uuid=False), sa.ForeignKey("job_batches.id", ondelete="RESTRICT"), nullable=False, unique=True),
        sa.Column("job_id", UUID(as_uuid=False), sa.ForeignKey("jobs.id", ondelete="RESTRICT"), nullable=False, unique=True),
        sa.Column("state", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("result", JSONB()),
        sa.Column("error", JSONB()),
        *timestamps(),
        sa.UniqueConstraint("trial_id", "stage", "generation", name="uq_cae_stage_generation"),
    )
    op.create_index("ix_cae_stage_submissions_trial_id", "cae_stage_submissions", ["trial_id"])


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM cae_studies)")):
        raise RuntimeError("Delete retained Studies before downgrading parameter optimization.")
    for table in ("cae_stage_submissions", "cae_trials", "cae_studies"):
        op.drop_table(table)
