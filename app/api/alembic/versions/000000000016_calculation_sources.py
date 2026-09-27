"""Share immutable Calculation source while preserving Experiment binding IDs."""
import hashlib

from alembic import op
import sqlalchemy as sa

revision = "000000000016"
down_revision = "000000000015"
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    connection.execute(sa.text("LOCK TABLE calculations IN ACCESS EXCLUSIVE MODE"))
    inspector = sa.inspect(connection)
    columns = {column["name"] for column in inspector.get_columns("calculations")}
    # The baseline builds current ORM metadata on fresh databases. Older
    # migrations may still add source_hash, but only deployed old databases
    # have source_code to backfill.
    if "source_code" in columns:
        op.create_table(
            "calculation_sources",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("source_code", sa.Text(), nullable=False),
            sa.Column("source_hash", sa.Text(), nullable=False),
            sa.UniqueConstraint("source_hash", name="uq_calculation_sources_source_hash"),
        )
        op.add_column("calculations", sa.Column("source_id", sa.Integer(), nullable=True))
        last_id = 0
        while True:
            rows = connection.execute(sa.text(
                "SELECT id, source_code, source_hash, contract_status FROM calculations "
                "WHERE id > :last_id ORDER BY id LIMIT 500"
            ), {"last_id": last_id}).mappings().all()
            if not rows:
                break
            for row in rows:
                digest = hashlib.sha256(row["source_code"].encode("utf-8")).hexdigest()
                if row["contract_status"] == "ready" and row["source_hash"] != digest:
                    raise RuntimeError(
                        f"Calculation {row['id']} is ready but its source hash does not match. "
                        "Migration aborted; inspect and preflight this Calculation before retrying."
                    )
                connection.execute(sa.text(
                    "INSERT INTO calculation_sources (source_code, source_hash) VALUES (:code, :hash) "
                    "ON CONFLICT (source_hash) DO NOTHING"
                ), {"code": row["source_code"], "hash": digest})
                source = connection.execute(sa.text(
                    "SELECT id, source_code FROM calculation_sources WHERE source_hash = :hash"
                ), {"hash": digest}).mappings().one()
                if source["source_code"] != row["source_code"]:
                    raise RuntimeError(f"Calculation {row['id']} source hash collision; migration aborted.")
                connection.execute(sa.text("UPDATE calculations SET source_id = :source_id WHERE id = :id"),
                                   {"source_id": source["id"], "id": row["id"]})
            last_id = rows[-1]["id"]
        op.alter_column("calculations", "source_id", nullable=False)
        op.create_foreign_key("fk_calculations_source_id_calculation_sources", "calculations", "calculation_sources",
                              ["source_id"], ["id"], ondelete="RESTRICT")
        op.create_index("ix_calculations_source_id", "calculations", ["source_id"])
        op.drop_column("calculations", "source_code")
        op.drop_column("calculations", "source_hash")
    elif "source_hash" in columns:
        op.drop_column("calculations", "source_hash")
    connection.execute(sa.text("""
        CREATE FUNCTION reject_calculation_source_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NEW IS DISTINCT FROM OLD THEN
                RAISE EXCEPTION 'Calculation sources are immutable';
            END IF;
            RETURN NEW;
        END;
        $$
    """))
    connection.execute(sa.text("""
        CREATE TRIGGER calculation_sources_immutable BEFORE UPDATE ON calculation_sources
        FOR EACH ROW EXECUTE FUNCTION reject_calculation_source_update()
    """))


def downgrade():
    connection = op.get_bind()
    connection.execute(sa.text("LOCK TABLE calculations IN ACCESS EXCLUSIVE MODE"))
    op.add_column("calculations", sa.Column("source_code", sa.Text(), nullable=True))
    op.add_column("calculations", sa.Column("source_hash", sa.Text(), nullable=True))
    connection.execute(sa.text("""
        UPDATE calculations c SET source_code = s.source_code, source_hash = s.source_hash
        FROM calculation_sources s WHERE s.id = c.source_id
    """))
    op.alter_column("calculations", "source_code", nullable=False)
    op.drop_index("ix_calculations_source_id", table_name="calculations")
    op.drop_constraint("fk_calculations_source_id_calculation_sources", "calculations", type_="foreignkey")
    op.drop_column("calculations", "source_id")
    op.drop_table("calculation_sources")
    connection.execute(sa.text("DROP FUNCTION reject_calculation_source_update()"))
