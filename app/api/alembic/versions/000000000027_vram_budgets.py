"""Convert stored request budgets to GiB; leave execution allocations untouched."""
from decimal import Decimal, ROUND_CEILING

from alembic import op
import sqlalchemy as sa

revision = "000000000027"
down_revision = "000000000026"
branch_labels = None
depends_on = None


def convert_resources(value: dict, *, downgrade: bool = False) -> dict:
    result = dict(value or {})
    source, target = ("vram_budget_gb", "gpu_memory_bytes") if downgrade else ("gpu_memory_bytes", "vram_budget_gb")
    if source not in result:
        return result
    if target in result:
        raise ValueError("Conflicting old/new GPU budget in stored request")
    amount = result.pop(source)
    if type(amount) not in (int, float) or not Decimal(str(amount)).is_finite() or amount < 0:
        raise ValueError("Invalid stored GPU memory budget")
    if amount:
        result[target] = (int((Decimal(str(amount)) * 1024**3).to_integral_value(rounding=ROUND_CEILING))
                          if downgrade else float(Decimal(str(amount)) / 1024**3))
    return result


def migrate(downgrade: bool = False):
    connection = op.get_bind()
    for name, key in (("jobs", "id"), ("execution_attempts", "id"), ("prediction_training_runs", "operation_id")):
        table = sa.table(name, sa.column(key), sa.column("resources", sa.JSON))
        rows = connection.execute(sa.select(table.c[key], table.c.resources)).mappings()
        for row in rows:
            changed = convert_resources(row["resources"], downgrade=downgrade)
            if changed != row["resources"]:
                connection.execute(table.update().where(table.c[key] == row[key]).values(resources=changed))
    # Evaluation requests pin the child request inside their input. Do not walk
    # arbitrary input dictionaries: physical model inputs may use the same name.
    jobs = sa.table("jobs", sa.column("id"), sa.column("handler_type"), sa.column("input", sa.JSON))
    rows = connection.execute(sa.select(jobs.c.id, jobs.c.input).where(
        jobs.c.handler_type == "cae.evaluation.predict")).mappings()
    for row in rows:
        payload = row["input"] or {}
        hybrid = payload.get("hybrid") or {}
        if "resources" not in hybrid:
            continue
        resources = {key: convert_resources(value, downgrade=downgrade) for key, value in hybrid["resources"].items()}
        changed = {**payload, "hybrid": {**hybrid, "resources": resources}}
        if changed != payload:
            connection.execute(jobs.update().where(jobs.c.id == row["id"]).values(input=changed))


def upgrade():
    migrate()


def downgrade():
    migrate(downgrade=True)
