"""Optional parameter descriptors survive CLI edits, cloning and schema rebases."""

import sqlite3
from contextlib import closing

from caemble_catalog import open_catalog
from caemble_catalog.cli import main
from caemble_catalog.schema import create_schema


def catalog_command(path, *arguments):
    code = main(["--database", str(path), *arguments])
    assert code == 0, arguments


def prepare_catalog(path):
    with closing(sqlite3.connect(path)) as connection:
        create_schema(connection)
    catalog_command(path, "solver", "create", "fixture", "1.0.0",
                    "--implementation", "app.solvers.fixture.entry:implementation",
                    "--description", "Fixture", "--minimum-outputs", "0")
    catalog_command(path, "solver", "parameter", "upsert", "fixture", "1.0.0", "analysis",
                    "--description", "Analysis selector", "--data-json", '{"dtype":"string"}')
    catalog_command(path, "solver", "method", "upsert", "fixture", "1.0.0", "initializations", "fixture.time",
                    "--description", "Clock", "--minimum-occurrences", "0", "--maximum-occurrences", "1",
                    "--target-source", "experiment", "--target-kind", "geometry", "--minimum-targets", "0",
                    "--maximum-targets", "0", "--minimum-resolved", "0", "--maximum-resolved", "0")
    catalog_command(path, "solver", "method-parameter", "upsert", "fixture", "1.0.0", "initializations",
                    "fixture.time", "windowSteps", "--description", "Window steps", "--data-json", '{"dtype":"int32"}')


def test_optional_parameters_survive_cli_clone_and_rebase(tmp_path):
    path = tmp_path / "draft.sqlite3"
    prepare_catalog(path)
    catalog_command(path, "solver", "parameter", "upsert", "fixture", "1.0.0", "analysis",
                    "--description", "Analysis selector", "--data-json", '{"dtype":"string"}', "--no-required")
    catalog_command(path, "solver", "method-parameter", "upsert", "fixture", "1.0.0", "initializations",
                    "fixture.time", "windowSteps", "--description", "Window steps", "--data-json", '{"dtype":"int32"}', "--no-required")
    catalog_command(path, "solver", "clone", "fixture", "1.0.0", "1.1.0")
    catalog_command(path, "rebase")
    with open_catalog(path) as catalog:
        for version in ("1.0.0", "1.1.0"):
            descriptor = catalog.get_solver_manifest("fixture", version)["descriptor"]
            assert descriptor["parameters"]["analysis"] == {
                "description": "Analysis selector", "data": {"dtype": "string"}, "required": False,
            }
            assert descriptor["methods"]["initializations"][0]["parameters"]["windowSteps"]["required"] is False
    catalog_command(path, "solver", "parameter", "upsert", "fixture", "1.1.0", "analysis",
                    "--description", "Analysis selector", "--data-json", '{"dtype":"string"}', "--required")
    with open_catalog(path) as catalog:
        assert "required" not in catalog.get_solver_manifest("fixture", "1.1.0")["descriptor"]["parameters"]["analysis"]


def test_schema_four_rebase_preserves_required_descriptor_shape(tmp_path):
    source, draft = tmp_path / "legacy.sqlite3", tmp_path / "rebased.sqlite3"
    prepare_catalog(source)
    with open_catalog(source) as catalog:
        expected = catalog.get_solver_manifest("fixture", "1.0.0")
    # Construct an old-schema fixture only; actual Catalog edits use the Draft CLI.
    with closing(sqlite3.connect(source)) as connection:
        connection.execute("ALTER TABLE solver_parameters DROP COLUMN required")
        connection.execute("ALTER TABLE solver_method_parameters DROP COLUMN required")
        connection.execute("PRAGMA user_version = 4")
        connection.commit()
    catalog_command(draft, "draft", "create", "--source", str(source))
    catalog_command(draft, "rebase")
    with open_catalog(draft) as catalog:
        assert catalog.get_solver_manifest("fixture", "1.0.0") == expected
    with closing(sqlite3.connect(source)) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 4
