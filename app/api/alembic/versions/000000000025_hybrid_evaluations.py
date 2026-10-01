"""Separate candidate identities from frozen Solver and Prediction evaluations."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "000000000025"
down_revision = "000000000024"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("cae_evaluations",
        sa.Column("id", UUID(as_uuid=False), primary_key=True),
        sa.Column("optimization_id", UUID(as_uuid=False), sa.ForeignKey("cae_optimizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("trial_id", UUID(as_uuid=False), sa.ForeignKey("cae_trials.id", ondelete="CASCADE"), nullable=False),
        sa.Column("fingerprint", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("definition_hash", sa.Text(), nullable=False),
        sa.Column("source_hash", sa.Text(), nullable=False),
        sa.Column("source", JSONB(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("next_stage", sa.Text(), nullable=False),
        sa.Column("measurement_id", sa.Integer(), sa.ForeignKey("measurements.id", ondelete="RESTRICT")),
        sa.Column("artifact", JSONB()), sa.Column("result", JSONB()), sa.Column("error", JSONB()),
        sa.Column("manual_retry_requested", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("retry_request_id", UUID(as_uuid=False)),
        sa.Column("retry_requests", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("optimization_id", "fingerprint", "kind", "definition_hash", "source_hash", name="uq_cae_evaluations_identity"),
        sa.CheckConstraint("kind IN ('solver', 'prediction')", name="evaluation_kind"),
    )
    for column in ("optimization_id", "trial_id", "measurement_id"):
        op.create_index(f"ix_cae_evaluations_{column}", "cae_evaluations", [column])
    op.create_table("cae_evaluation_submissions",
        sa.Column("evaluation_id", UUID(as_uuid=False), sa.ForeignKey("cae_evaluations.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("submission_id", UUID(as_uuid=False), sa.ForeignKey("cae_stage_submissions.id", ondelete="CASCADE"), primary_key=True),
    )
    # Reuse the old Trial UUID for its Solver Evaluation. Execution identities,
    # frozen hashes and in-flight retry receipts are copied without rewriting Jobs.
    op.execute("""
        INSERT INTO cae_evaluations
            (id,optimization_id,trial_id,fingerprint,kind,definition_hash,source_hash,source,
             state,next_stage,measurement_id,result,error,manual_retry_requested,retry_request_id,
             retry_requests,created_at,updated_at)
        SELECT t.id,t.optimization_id,t.id,t.fingerprint,'solver',o.definition->>'hash',
            COALESCE(o.definition->>'source_hash',o.definition->>'hash'),
            jsonb_build_object('source_hash',o.definition->>'source_hash','catalog_revision',o.definition->>'catalog_revision'),
            t.state,t.next_stage,t.measurement_id,t.result,t.error,t.manual_retry_requested,t.retry_request_id,
            t.retry_requests,t.created_at,t.updated_at
        FROM cae_trials t JOIN cae_optimizations o ON o.id=t.optimization_id
    """)
    op.execute("INSERT INTO cae_evaluation_submissions SELECT trial_id,id FROM cae_stage_submissions")


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM cae_evaluations WHERE kind='prediction')")):
        raise RuntimeError("Hybrid evaluations cannot be represented by legacy Trials; retain the upgraded database.")
    op.drop_table("cae_evaluation_submissions")
    op.drop_table("cae_evaluations")
