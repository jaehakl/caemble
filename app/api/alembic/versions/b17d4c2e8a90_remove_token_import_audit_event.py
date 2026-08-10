"""remove the retired GPStation token import audit event

Revision ID: b17d4c2e8a90
Revises: a4c8e2f19b73
Create Date: 2026-08-10
"""

from collections.abc import Sequence

from alembic import op


revision: str = "b17d4c2e8a90"
down_revision: str | Sequence[str] | None = "a4c8e2f19b73"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


AUDIT_CONSTRAINT_NAME = "ck_auth_audit_ck_auth_audit_event"


def upgrade() -> None:
    op.execute("DELETE FROM auth_audit WHERE event = 'token_imported'")
    op.drop_constraint(
        op.f(AUDIT_CONSTRAINT_NAME),
        "auth_audit",
        type_="check",
    )
    op.create_check_constraint(
        op.f(AUDIT_CONSTRAINT_NAME),
        "auth_audit",
        "event IN ("
        "'login_success','login_failure','logout','link_success','unlink',"
        "'token_created','token_revoked',"
        "'launcher_connected','launcher_rejected','launcher_disconnected'"
        ")",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f(AUDIT_CONSTRAINT_NAME),
        "auth_audit",
        type_="check",
    )
    op.create_check_constraint(
        op.f(AUDIT_CONSTRAINT_NAME),
        "auth_audit",
        "event IN ("
        "'login_success','login_failure','logout','link_success','unlink',"
        "'token_created','token_revoked','token_imported',"
        "'launcher_connected','launcher_rejected','launcher_disconnected'"
        ")",
    )
