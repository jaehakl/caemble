"""Retain live Hybrid model bindings without changing frozen definitions."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "000000000028"
down_revision = "000000000027"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("cae_optimization_model_pins",
        sa.Column("optimization_id", UUID(as_uuid=False), sa.ForeignKey("cae_optimizations.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("slot", sa.Text(), primary_key=True),
        sa.Column("model_id", UUID(as_uuid=False), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("replica_id", UUID(as_uuid=False), nullable=False),
        sa.Column("storage_id", UUID(as_uuid=False), nullable=False))
    op.create_index("ix_cae_optimization_model_pins_model_id", "cae_optimization_model_pins", ["model_id"])
    op.create_index("ix_cae_optimization_model_pins_replica_id", "cae_optimization_model_pins", ["replica_id"])
    op.execute("""UPDATE cae_optimizations SET optimizer_state = optimizer_state || jsonb_build_object(
        'model_update', jsonb_build_object('initial_model', definition->'hybrid',
        'active_model', definition->'hybrid', 'round_model', definition->'hybrid',
        'pending_model', NULL, 'updates', '[]'::jsonb, 'waiting', false))
        WHERE definition ? 'hybrid' AND NOT optimizer_state ? 'model_update'""")
    op.execute("""INSERT INTO cae_optimization_model_pins
        (optimization_id,slot,model_id,revision,replica_id,storage_id)
        SELECT id, slot, (definition->'hybrid'->>'model_id')::uuid,
        (definition->'hybrid'->>'model_revision')::integer,
        (definition->'hybrid'->>'replica_id')::uuid,
        (definition->'hybrid'->>'storage_id')::uuid
        FROM cae_optimizations CROSS JOIN (VALUES ('active'),('round')) AS slots(slot)
        WHERE definition ? 'hybrid' AND state != 'completed'""")


def downgrade():
    op.drop_table("cae_optimization_model_pins")
