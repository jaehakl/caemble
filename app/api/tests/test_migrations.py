from itertools import pairwise
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text


def alembic_config() -> Config:
    return Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))


def test_alembic_history_is_one_connected_chain():
    config = alembic_config()
    script = ScriptDirectory.from_config(config)

    assert len(script.get_bases()) == 1
    assert len(script.get_heads()) == 1
    revisions = list(script.walk_revisions())
    assert revisions[-1].down_revision is None
    assert all(revision.down_revision == parent.revision for revision, parent in pairwise(revisions))


def test_experiment_versioning_migration_renders_offline_sql(capsys):
    command.upgrade(
        alembic_config(),
        "a81d6c4e2f90:c5e2a9d7f410",
        sql=True,
    )
    sql = capsys.readouterr().out

    assert "DELETE FROM experiments" in sql
    assert "DROP TABLE IF EXISTS geometry_repositories CASCADE" in sql
    assert "UPDATE users SET geometry_namespace = NULL" in sql
    assert "WHERE geometry_namespace = 'caemble'" in sql
    assert "RENAME geometry_namespace TO experiment_namespace" in sql
    assert "namespace <> 'caemble'" in sql
    assert "ON DELETE CASCADE" in sql
    assert "CREATE INDEX ix_designer_models_experiment_id" in sql
    assert "CREATE INDEX ix_predictor_models_experiment_id" in sql
    assert sql.index("UPDATE users SET geometry_namespace = NULL") < sql.index(
        "RENAME geometry_namespace TO experiment_namespace"
    )


def test_experiment_versioning_downgrade_renders_data_loss_guard(capsys):
    command.downgrade(
        alembic_config(),
        "c5e2a9d7f410:a81d6c4e2f90",
        sql=True,
    )
    sql = capsys.readouterr().out

    assert "IF EXISTS (SELECT 1 FROM experiments)" in sql
    assert "Cannot downgrade while versioned Experiments exist" in sql
    assert "DROP INDEX ix_designer_models_experiment_id" in sql
    assert "DROP INDEX ix_predictor_models_experiment_id" in sql
    assert "CREATE TABLE geometry_repositories" in sql


@pytest.mark.slow
@pytest.mark.asyncio
async def test_configured_database_is_at_the_alembic_head(db_session):
    config = alembic_config()
    script = ScriptDirectory.from_config(config)
    applied = set(
        (await db_session.execute(text("SELECT version_num FROM alembic_version"))).scalars()
    )

    assert applied == set(script.get_heads())
