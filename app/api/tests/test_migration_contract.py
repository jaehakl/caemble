from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text


def test_initial_revision_contains_extension_enum_tables_and_role_seed():
    revision = next((Path(__file__).resolve().parents[1] / "alembic" / "versions").glob("*_initial_schema.py"))
    source = revision.read_text(encoding="utf-8")
    assert "CREATE EXTENSION IF NOT EXISTS vector" in source
    assert "name='oauth_provider'" in source
    assert "ON CONFLICT (name) DO NOTHING" in source
    for table in ("users", "identities", "structures", "experiments", "samples", "setups", "recorded_data"):
        assert f"op.create_table('{table}'" in source


def test_measurement_uniqueness_revision_keeps_latest_duplicate():
    revision = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob(
            "*_add_measurement_sample_setup_uniqueness.py"
        )
    )
    source = revision.read_text(encoding="utf-8")
    assert "PARTITION BY sample_id, setup_id" in source
    assert "ORDER BY updated_at DESC, id DESC" in source
    assert "duplicate_rank > 1" in source
    assert "uq_measurements_sample_id_setup_id" in source


def test_experiment_simulation_code_revision_is_nullable_and_reversible():
    revision = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob(
            "*_add_experiment_simulation_code.py"
        )
    )
    source = revision.read_text(encoding="utf-8")
    assert 'down_revision: Union[str, Sequence[str], None] = "b6e2a21f4c9d"' in source
    assert 'sa.Column("simulation_code", sa.Text(), nullable=True)' in source
    assert 'op.drop_column("users", "gps_access_token")' in source
    assert 'sa.Column("gps_access_token", sa.Text(), nullable=True)' in source
    assert 'op.drop_column("experiments", "simulation_code")' in source


def test_recorded_data_schema_revision_keeps_legacy_rows_readable():
    revision = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob(
            "*_add_recorded_data_schema.py"
        )
    )
    source = revision.read_text(encoding="utf-8")
    assert 'down_revision: Union[str, Sequence[str], None] = "c4f8e21a9b6d"' in source
    assert 'sa.Column("data_schema", postgresql.JSONB' in source
    assert '"quantity_kind"' in source
    assert "nullable=True" in source
    assert "SET quantity_kind = 'Dimensionless'" in source
    assert 'op.drop_column("recorded_data", "data_schema")' in source


def test_gpstation_connection_revision_is_separate_from_users_and_reversible():
    revision = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob(
            "*_add_gpstation_connections.py"
        )
    )
    source = revision.read_text(encoding="utf-8")
    assert 'down_revision: Union[str, Sequence[str], None] = "f24a6b91d3ce"' in source
    assert '"gpstation_connections"' in source
    assert 'sa.PrimaryKeyConstraint("user_id"' in source
    assert '["users.id"]' in source
    assert 'ondelete="CASCADE"' in source
    assert 'op.drop_table("gpstation_connections")' in source


def test_deployed_revision_marker_is_a_noop_compatibility_revision():
    revision = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob(
            "f24a6b91d3ce_*.py"
        )
    )
    source = revision.read_text(encoding="utf-8")
    assert 'revision: str = "f24a6b91d3ce"' in source
    assert 'down_revision: Union[str, Sequence[str], None] = "e7b2c5d91a40"' in source
    assert source.count("    pass") == 2


def test_source_migration_graph_ends_at_gpstation_connections():
    root = Path(__file__).resolve().parents[1]
    scripts = ScriptDirectory.from_config(Config(root / "alembic.ini"))

    assert scripts.get_heads() == ["9d31a6f7c2e4"]
    assert scripts.get_revision("f24a6b91d3ce").down_revision == "e7b2c5d91a40"
    assert scripts.get_revision("9d31a6f7c2e4").down_revision == "f24a6b91d3ce"
    assert not any(root.joinpath("alembic", "versions").glob("*_measurement_contract_metadata.py"))


@pytest.mark.asyncio
async def test_configured_database_has_seeded_roles_and_required_extensions(db_session):
    roles = list((await db_session.execute(text("SELECT name FROM roles ORDER BY name"))).scalars())
    vector = await db_session.scalar(text("SELECT extversion FROM pg_extension WHERE extname = 'vector'"))
    persisted_token_columns = await db_session.scalar(
        text(
            """
            SELECT count(*)
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'users'
              AND column_name = 'gps_access_token'
            """
        )
    )
    gpstation_columns = list(
        (
            await db_session.execute(
                text(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'gpstation_connections'
                    ORDER BY ordinal_position
                    """
                )
            )
        ).scalars()
    )
    assert roles == ["admin", "user"]
    assert vector
    assert persisted_token_columns == 0
    assert gpstation_columns == [
        "user_id",
        "api_base_url",
        "access_token",
        "created_at",
        "updated_at",
    ]
