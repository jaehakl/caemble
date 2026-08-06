from pathlib import Path

import pytest
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


@pytest.mark.asyncio
async def test_configured_database_is_at_head_with_seeded_roles(db_session):
    revision = await db_session.scalar(text("SELECT version_num FROM alembic_version"))
    roles = list((await db_session.execute(text("SELECT name FROM roles ORDER BY name"))).scalars())
    vector = await db_session.scalar(text("SELECT extversion FROM pg_extension WHERE extname = 'vector'"))
    assert revision == "b6e2a21f4c9d"
    assert roles == ["admin", "user"]
    assert vector
