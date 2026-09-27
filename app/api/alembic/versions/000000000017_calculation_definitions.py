"""Owned shared Calculation metadata and declared contracts."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "000000000017"
down_revision = "000000000016"
branch_labels = None
depends_on = None


def upgrade():
    db = op.get_bind()
    db.execute(sa.text("LOCK TABLE calculation_sources, calculations IN ACCESS EXCLUSIVE MODE"))
    db.execute(sa.text("DROP TRIGGER IF EXISTS calculation_sources_immutable ON calculation_sources"))
    db.execute(sa.text("DROP FUNCTION IF EXISTS reject_calculation_source_update()"))
    inspector = sa.inspect(db)
    if "name" not in {c["name"] for c in inspector.get_columns("calculation_sources")}:
        for column in [sa.Column("name", sa.Text()), sa.Column("description", sa.Text()),
                       sa.Column("owner_id", UUID(as_uuid=False)),
                       sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
                       sa.Column("input_contract", JSONB()), sa.Column("output_contract", JSONB()),
                       sa.Column("contract_hash", sa.Text())]:
            op.add_column("calculation_sources", column)
        op.create_foreign_key("fk_calculation_sources_owner_id_users", "calculation_sources", "users", ["owner_id"], ["id"], ondelete="SET NULL")
        db.execute(sa.text("""
            UPDATE calculation_sources s SET name = first.name, description = first.description, owner_id = first.user_id
            FROM (SELECT DISTINCT ON (c.source_id) c.source_id, c.name, c.description, e.user_id
                  FROM calculations c JOIN experiments e ON e.id = c.experiment_id ORDER BY c.source_id, c.id) first
            WHERE s.id = first.source_id
        """))
        db.execute(sa.text("UPDATE calculation_sources SET name = 'Calculation #' || id WHERE name IS NULL"))
        op.alter_column("calculation_sources", "name", nullable=False)
        op.add_column("calculations", sa.Column("validated_source_revision", sa.Integer()))
        db.execute(sa.text("UPDATE calculations SET validated_source_revision = 1 WHERE contract_status = 'ready'"))
    if not inspector.has_table("calculation_legacy_metadata"):
        op.create_table("calculation_legacy_metadata",
                        sa.Column("calculation_id", sa.Integer(), sa.ForeignKey("calculations.id", ondelete="CASCADE"), primary_key=True),
                        sa.Column("name", sa.Text(), nullable=False), sa.Column("description", sa.Text()))
    if "name" in {c["name"] for c in inspector.get_columns("calculations")}:
        db.execute(sa.text("INSERT INTO calculation_legacy_metadata SELECT id, name, description FROM calculations"))
        op.drop_constraint("uq_calculations_experiment_id_name", "calculations", type_="unique")
        op.drop_column("calculations", "name")
        op.drop_column("calculations", "description")
    # Legacy source is deliberately not rewritten or inferred from old preflights.


def downgrade():
    db = op.get_bind()
    db.execute(sa.text("LOCK TABLE calculation_sources, calculations IN ACCESS EXCLUSIVE MODE"))
    op.add_column("calculations", sa.Column("name", sa.Text()))
    op.add_column("calculations", sa.Column("description", sa.Text()))
    db.execute(sa.text("UPDATE calculations c SET name=s.name, description=s.description FROM calculation_sources s WHERE c.source_id=s.id"))
    db.execute(sa.text("UPDATE calculations c SET name=old.name, description=old.description FROM calculation_legacy_metadata old WHERE c.id=old.calculation_id"))
    if db.execute(sa.text("SELECT 1 FROM calculations GROUP BY experiment_id, name HAVING count(*) > 1 LIMIT 1")).first():
        raise RuntimeError("Downgrade has duplicate Experiment Calculation names. Resolve new duplicate bindings before retrying; no data was changed.")
    op.alter_column("calculations", "name", nullable=False)
    op.create_unique_constraint("uq_calculations_experiment_id_name", "calculations", ["experiment_id", "name"])
    op.drop_table("calculation_legacy_metadata")
    op.drop_column("calculations", "validated_source_revision")
    op.drop_constraint("fk_calculation_sources_owner_id_users", "calculation_sources", type_="foreignkey")
    for column in ["name", "description", "owner_id", "revision", "input_contract", "output_contract", "contract_hash"]:
        op.drop_column("calculation_sources", column)
    db.execute(sa.text("""CREATE FUNCTION reject_calculation_source_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Calculation sources are immutable'; END IF; RETURN NEW; END; $$"""))
    db.execute(sa.text("CREATE TRIGGER calculation_sources_immutable BEFORE UPDATE ON calculation_sources FOR EACH ROW EXECUTE FUNCTION reject_calculation_source_update()"))
