from pathlib import Path

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from user_auth.db import AuthAudit


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


def test_source_migration_graph_continues_to_cae_workbench_indexes():
    root = Path(__file__).resolve().parents[1]
    scripts = ScriptDirectory.from_config(Config(root / "alembic.ini"))

    assert scripts.get_heads() == ["8d4e2f6a1b30"]
    assert scripts.get_revision("f24a6b91d3ce").down_revision == "e7b2c5d91a40"
    assert scripts.get_revision("9d31a6f7c2e4").down_revision == "f24a6b91d3ce"
    assert scripts.get_revision("a4c8e2f19b73").down_revision == "9d31a6f7c2e4"
    assert scripts.get_revision("b17d4c2e8a90").down_revision == "a4c8e2f19b73"
    assert scripts.get_revision("d2f7a1c9e4b6").down_revision == "b17d4c2e8a90"
    assert scripts.get_revision("e91f6b3a2c7d").down_revision == "d2f7a1c9e4b6"
    assert scripts.get_revision("f6a8c1d2e3b4").down_revision == "e91f6b3a2c7d"
    assert scripts.get_revision("4c91e2a7b5d8").down_revision == "f6a8c1d2e3b4"
    assert scripts.get_revision("7b2d8f4a6c10").down_revision == "4c91e2a7b5d8"
    assert scripts.get_revision("8d4e2f6a1b30").down_revision == "7b2d8f4a6c10"
    assert not any(root.joinpath("alembic", "versions").glob("*_measurement_contract_metadata.py"))


def test_unified_research_revision_resets_only_research_data_and_replaces_split_schema():
    revision = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob(
            "*_unify_research_entities.py"
        )
    )
    source = revision.read_text(encoding="utf-8")
    upgrade = source.split("def downgrade()", 1)[0]
    for table in (
        "recorded_data",
        "measurements",
        "designer_models",
        "predictor_models",
        "samples",
        "setups",
        "structures",
        "experiments",
    ):
        assert f'DELETE FROM {table}' in upgrade
    for table in ("samples", "setups", "structures"):
        assert f'op.drop_table("{table}")' in upgrade
    for untouched in ("geometries", "materials", "jobs"):
        assert f'DELETE FROM {untouched}' not in upgrade
        assert f'op.drop_table("{untouched}")' not in upgrade
    assert '"source_hash"' in upgrade
    assert '"recorded_at"' in upgrade
    assert '"user_id"' in upgrade
    assert "nullable=False" in upgrade
    assert 'ondelete="RESTRICT"' in upgrade
    assert '"uq_recorded_data_measurement_id_name"' in upgrade
    for constraint in (
        "ck_experiments_source_hash_sha256",
        "ck_measurements_vars_object",
        "ck_measurements_material_parameters_object",
        "ck_measurements_material_parameters_v2",
    ):
        assert f'op.f("{constraint}")' in source


def test_cae_workbench_query_index_revision_is_non_destructive_and_reversible():
    revision = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob(
            "*_add_cae_workbench_query_indexes.py"
        )
    )
    source = revision.read_text(encoding="utf-8")
    expected_indexes = {
        "ix_structures_parent_id": ("structures", '["parent_id"]'),
        "ix_experiments_parent_id": ("experiments", '["parent_id"]'),
        "ix_samples_structure_id": ("samples", '["structure_id"]'),
        "ix_setups_experiment_id": ("setups", '["experiment_id"]'),
        "ix_measurements_setup_id": ("measurements", '["setup_id"]'),
        "ix_measurements_user_id_updated_at": (
            "measurements",
            '["user_id", "updated_at"]',
        ),
        "ix_recorded_data_measurement_id": ("recorded_data", '["measurement_id"]'),
    }

    upgrade = source.split("def downgrade()", 1)[0]
    assert "drop_table" not in upgrade
    assert "drop_column" not in upgrade
    for index_name, (table_name, columns) in expected_indexes.items():
        assert f'"{index_name}"' in upgrade
        assert f'"{table_name}"' in upgrade
        assert columns in upgrade
        assert f'"{index_name}"' in source.split("def downgrade()", 1)[1]


def test_experiment_source_bundle_revision_guards_non_empty_tables():
    revision = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob(
            "*_use_experiment_source_bundles.py"
        )
    )
    source = revision.read_text(encoding="utf-8")
    assert "SELECT count(*) FROM experiments" in source
    assert "raise RuntimeError" in source
    assert 'sa.Column("source_bundle", postgresql.JSONB' in source
    assert 'op.drop_column("experiments", "code")' in source
    assert 'op.drop_column("experiments", "simulation_code")' in source


def test_geometry_module_revision_guards_legacy_rows_and_creates_immutable_schema():
    revision = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob(
            "*_add_immutable_geometry_modules.py"
        )
    )
    source = revision.read_text(encoding="utf-8")
    assert "SELECT count(*) FROM geometries" in source
    assert "Export the legacy rows as JSON" in source
    assert "manual repository/package/version mapping" in source
    assert 'op.drop_table("geometries")' in source
    assert 'op.add_column("users", sa.Column("geometry_namespace"' in source
    for table in (
        "geometry_repositories",
        "geometry_packages",
        "geometry_versions",
        "geometry_imports",
        "experiment_geometry_roots",
    ):
        assert f'"{table}"' in source
    assert "uq_geometry_versions_package_id_semver" in source
    assert "module_format_version = 1" in source
    assert "cad_api_version = 5" in source
    assert 'sa.Column("namespace", sa.Text(), nullable=False)' in source
    assert "uq_geometry_repositories_namespace_slug" in source
    assert 'ondelete="SET NULL"' in source
    assert "archive_geometry_repositories_before_user_delete" in source
    assert "guard_geometry_namespace_reservation" in source
    assert "validate_geometry_repository_owner_namespace" in source
    assert "protect_geometry_repository_identity" in source
    assert "protect_geometry_package_identity" in source
    assert "protect_geometry_version" in source
    assert "protect_geometry_import" in source


def test_geometry_manager_revision_projects_all_modules_and_allows_controlled_cleanup():
    revision = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob(
            "*_add_geometry_manager_projection.py"
        )
    )
    source = revision.read_text(encoding="utf-8")
    upgrade = source.split("def downgrade()", 1)[0]
    assert '"experiment_geometry_modules"' in source
    assert "jsonb_array_elements" in source
    assert "geometrySnapshot" in source
    assert "ON CONFLICT DO NOTHING" in source
    assert "namespace_mutable=True" in upgrade
    assert "controlled_delete=True" in upgrade
    assert "caemble.geometry_delete" in source
    assert 'ondelete="RESTRICT"' in source
    assert 'op.drop_table("experiment_geometry_modules")' in source


def test_function_geometry_revision_discards_v1_data_and_sets_module_format_v2():
    revision = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob(
            "*_function_geometry_module_v2.py"
        )
    )
    source = revision.read_text(encoding="utf-8")
    assert "discarded_geometry_experiments" in source
    assert "DELETE FROM measurements" in source
    assert "DELETE FROM experiments" in source
    for table in (
        "geometry_imports",
        "geometry_versions",
        "geometry_packages",
        "geometry_repositories",
    ):
        assert f'DELETE FROM {table}' in source
    assert "_set_module_format(2)" in source
    assert "_set_module_format(1)" in source


def test_deployment_preflights_legacy_geometry_before_stopping_api():
    script = (Path(__file__).resolve().parents[3] / "deployment" / "update.sh").read_text(
        encoding="utf-8"
    )
    preflight = script.index("SELECT count(*) FROM geometries")
    stop_api = script.index('sudo systemctl stop "$API_SERVICE"')
    migration = script.index("poetry run alembic upgrade head")

    assert preflight < stop_api < migration
    assert "migration_succeeded=false" in script
    assert "migration_succeeded=true" in script
    assert "leaving the API stopped to avoid running new code on the old schema" in script


def test_runtime_revision_removes_legacy_connection_and_expands_audit_contract():
    revision = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob(
            "*_integrate_job_runtime.py"
        )
    )
    source = revision.read_text(encoding="utf-8")
    assert 'op.drop_table("gpstation_connections")' in source
    assert 'op.create_table(\n        "launchers"' in source
    assert 'op.create_table(\n        "jobs"' in source
    for column in (
        "key_prefix",
        "scopes",
        "status",
        "allowed_ips",
        "allowed_origins",
        "expires_at",
    ):
        assert f'"{column}"' in source
    for event in (
        "token_created",
        "token_revoked",
        "token_imported",
        "launcher_connected",
        "launcher_rejected",
        "launcher_disconnected",
    ):
        assert event in source


def test_token_import_cleanup_revision_deletes_logs_and_tightens_audit_contract():
    revision = next(
        (Path(__file__).resolve().parents[1] / "alembic" / "versions").glob(
            "*_remove_token_import_audit_event.py"
        )
    )
    source = revision.read_text(encoding="utf-8")
    upgrade = source.split("def downgrade()", 1)[0]
    assert "DELETE FROM auth_audit WHERE event = 'token_imported'" in upgrade
    assert "'token_created','token_revoked'," in upgrade
    assert "'token_created','token_revoked','token_imported'," not in upgrade


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
    legacy_connection_columns = list(
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
    runtime_tables = set(
        (
            await db_session.execute(
                text(
                    """
                    SELECT table_name
                    FROM information_schema.tables
                    WHERE table_schema = current_schema()
                      AND table_name IN ('jobs', 'launchers')
                    """
                )
            )
        ).scalars()
    )
    access_key_columns = set(
        (
            await db_session.execute(
                text(
                    """
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = 'api_keys'
                    """
                )
            )
        ).scalars()
    )
    assert legacy_connection_columns == []
    assert runtime_tables == {"jobs", "launchers"}
    assert {
        "key_type",
        "key_prefix",
        "scopes",
        "status",
        "rate_limit_per_minute",
        "allowed_ips",
        "allowed_origins",
        "expires_at",
    } <= access_key_columns
    owned_result_nullability = dict(
        (
            await db_session.execute(
                text(
                    """
                    SELECT table_name, is_nullable
                    FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name IN ('measurements', 'recorded_data')
                      AND column_name = 'user_id'
                    """
                )
            )
        ).all()
    )
    assert owned_result_nullability == {"measurements": "NO", "recorded_data": "NO"}


@pytest.mark.asyncio
@pytest.mark.parametrize("event", ["not_a_real_audit_event", "token_imported"])
async def test_auth_audit_check_rejects_events_outside_the_runtime_contract(
    db_session,
    event,
):
    db_session.add(AuthAudit(event=event))
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()
