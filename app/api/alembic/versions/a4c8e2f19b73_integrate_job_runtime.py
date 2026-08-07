"""integrate the Caemble job runtime

Revision ID: a4c8e2f19b73
Revises: 9d31a6f7c2e4
Create Date: 2026-08-07
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "a4c8e2f19b73"
down_revision: str | Sequence[str] | None = "9d31a6f7c2e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        op.f("ck_auth_audit_ck_auth_audit_event"),
        "auth_audit",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_auth_audit_ck_auth_audit_event"),
        "auth_audit",
        "event IN ("
        "'login_success','login_failure','logout','link_success','unlink',"
        "'token_created','token_revoked','token_imported',"
        "'launcher_connected','launcher_rejected','launcher_disconnected'"
        ")",
    )

    op.add_column(
        "api_keys",
        sa.Column("key_type", sa.Text(), server_default=sa.text("'user_api'"), nullable=False),
    )
    op.add_column("api_keys", sa.Column("key_prefix", sa.Text(), nullable=True))
    op.add_column(
        "api_keys",
        sa.Column(
            "scopes",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "api_keys",
        sa.Column("status", sa.Text(), server_default=sa.text("'active'"), nullable=False),
    )
    op.add_column("api_keys", sa.Column("rate_limit_per_minute", sa.Integer(), nullable=True))
    op.add_column(
        "api_keys",
        sa.Column("allowed_ips", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "api_keys",
        sa.Column("allowed_origins", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "api_keys",
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        """
        UPDATE api_keys
        SET key_prefix = 'legacy_' || substring(encode(key_hash, 'hex') FROM 1 FOR 16)
        WHERE key_prefix IS NULL
        """
    )
    op.alter_column("api_keys", "key_prefix", nullable=False)
    op.create_unique_constraint("uq_api_keys_key_prefix", "api_keys", ["key_prefix"])

    op.create_table(
        "launchers",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("launcher_name", sa.Text(), nullable=False),
        sa.Column("ip_address", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "slave_app_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("connected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_heartbeat_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("disconnected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_launchers_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_launchers")),
    )
    op.create_index("ix_launchers_user_id", "launchers", ["user_id"], unique=False)

    op.create_table(
        "jobs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("launcher_id", sa.UUID(), nullable=True),
        sa.Column("handler_type", sa.Text(), nullable=False),
        sa.Column("slave_app_id", sa.Text(), nullable=False),
        sa.Column(
            "offer",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("answer", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "progress",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("state", sa.Text(), server_default=sa.text("'queued'"), nullable=False),
        sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("answer_ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancel_requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("attempt_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["launcher_id"],
            ["launchers.id"],
            name=op.f("fk_jobs_launcher_id_launchers"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_jobs_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_jobs")),
    )
    op.create_index(
        "ix_jobs_queued_created",
        "jobs",
        ["created_at", "id"],
        unique=False,
        postgresql_where=sa.text("state = 'queued'"),
    )
    op.create_index(
        "ix_jobs_user_queued_created",
        "jobs",
        ["user_id", "created_at", "id"],
        unique=False,
        postgresql_where=sa.text("state = 'queued'"),
    )
    op.create_index(
        "ix_jobs_user_created_desc",
        "jobs",
        ["user_id", sa.literal_column("created_at DESC"), "id"],
        unique=False,
    )
    op.create_index(
        "ix_jobs_created_desc",
        "jobs",
        [sa.literal_column("created_at DESC"), "id"],
        unique=False,
    )
    op.create_index("ix_jobs_launcher_state", "jobs", ["launcher_id", "state"], unique=False)

    op.drop_table("gpstation_connections")


def downgrade() -> None:
    op.create_table(
        "gpstation_connections",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("api_base_url", sa.Text(), nullable=False),
        sa.Column("access_token", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_gpstation_connections_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_gpstation_connections")),
    )

    op.drop_index("ix_jobs_launcher_state", table_name="jobs")
    op.drop_index("ix_jobs_created_desc", table_name="jobs")
    op.drop_index("ix_jobs_user_created_desc", table_name="jobs")
    op.drop_index("ix_jobs_user_queued_created", table_name="jobs")
    op.drop_index("ix_jobs_queued_created", table_name="jobs")
    op.drop_table("jobs")
    op.drop_index("ix_launchers_user_id", table_name="launchers")
    op.drop_table("launchers")

    op.drop_constraint("uq_api_keys_key_prefix", "api_keys", type_="unique")
    op.drop_column("api_keys", "expires_at")
    op.drop_column("api_keys", "allowed_origins")
    op.drop_column("api_keys", "allowed_ips")
    op.drop_column("api_keys", "rate_limit_per_minute")
    op.drop_column("api_keys", "status")
    op.drop_column("api_keys", "scopes")
    op.drop_column("api_keys", "key_prefix")
    op.drop_column("api_keys", "key_type")

    op.drop_constraint(
        op.f("ck_auth_audit_ck_auth_audit_event"),
        "auth_audit",
        type_="check",
    )
    op.create_check_constraint(
        op.f("ck_auth_audit_ck_auth_audit_event"),
        "auth_audit",
        "event IN ('login_success','login_failure','logout','link_success','unlink')",
    )
