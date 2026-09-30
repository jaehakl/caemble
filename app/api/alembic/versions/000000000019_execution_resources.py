"""Resource reservations and fenced execution attempts; preserve historical results."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "000000000019"
down_revision = "000000000018"
branch_labels = None
depends_on = None


def upgrade():
    for table, columns in {
        "launchers": [sa.Column(name, sa.Text()) for name in ("installation_id", "boot_id", "session_id")]
        + [sa.Column("resources", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
           sa.Column("reconnect_deadline", sa.DateTime(timezone=True))],
        "jobs": [sa.Column("attempt_id", UUID(as_uuid=False))]
        + [sa.Column(name, sa.Text()) for name in ("instance_id", "reservation_id", "boot_id", "execution_phase", "cleanup_state", "waiting_reason")]
        + [sa.Column("resources", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")), sa.Column("allocation", JSONB())],
    }.items():
        existing = {item["name"] for item in sa.inspect(op.get_bind()).get_columns(table)}
        for column in columns:
            if column.name not in existing:
                op.add_column(table, column)
    constraints = {item["name"] for item in sa.inspect(op.get_bind()).get_unique_constraints("launchers")}
    if "uq_launchers_installation" not in constraints:
        op.create_unique_constraint("uq_launchers_installation", "launchers", ["user_id", "installation_id"])
    from gpstation.db import ExecutionAttempt
    ExecutionAttempt.__table__.create(op.get_bind(), checkfirst=True)
    attempt_columns = {item["name"] for item in sa.inspect(op.get_bind()).get_columns("execution_attempts")}
    for name in ("result_state", "cleanup_state"):
        if name not in attempt_columns:
            op.add_column("execution_attempts", sa.Column(name, sa.Text()))


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM execution_attempts WHERE reservation_id IS NOT NULL AND cleaned_at IS NULL)")):
        raise RuntimeError("Clean every execution reservation before downgrading.")
    op.drop_table("execution_attempts")
    op.drop_constraint("uq_launchers_installation", "launchers", type_="unique")
    for name in ("installation_id", "boot_id", "session_id", "resources", "reconnect_deadline"):
        op.drop_column("launchers", name)
    for name in ("attempt_id", "instance_id", "reservation_id", "boot_id", "execution_phase", "cleanup_state", "waiting_reason", "resources", "allocation"):
        op.drop_column("jobs", name)
