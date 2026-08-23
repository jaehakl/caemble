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


def test_multi_namespace_migration_uses_only_existing_experiments(capsys):
    command.upgrade(
        alembic_config(),
        "c5e2a9d7f410:e4a1b7c9d2f0",
        sql=True,
    )
    sql = capsys.readouterr().out

    assert "CREATE TABLE experiment_namespaces" in sql
    assert "SELECT namespace, min(user_id::text)::uuid" in sql
    assert "HAVING count(DISTINCT user_id) = 1" in sql
    assert "Cannot migrate Experiment namespace owned by multiple users" in sql
    assert "fk_experiments_namespace_user_id_experiment_namespaces" in sql
    assert "DROP COLUMN experiment_namespace" in sql


def test_multi_namespace_downgrade_restores_single_namespace_guards(capsys):
    command.downgrade(
        alembic_config(),
        "e4a1b7c9d2f0:c5e2a9d7f410",
        sql=True,
    )
    sql = capsys.readouterr().out

    assert "ADD COLUMN experiment_namespace" in sql
    assert "CREATE FUNCTION guard_experiment_namespace_reservation()" in sql
    assert "CREATE FUNCTION validate_experiment_owner_namespace()" in sql
    assert "DROP TABLE experiment_namespaces" in sql


@pytest.mark.slow
@pytest.mark.asyncio
async def test_configured_database_is_at_the_alembic_head(db_session):
    config = alembic_config()
    script = ScriptDirectory.from_config(config)
    applied = set(
        (await db_session.execute(text("SELECT version_num FROM alembic_version"))).scalars()
    )

    assert applied == set(script.get_heads())
