from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

import pytest

from caemble_catalog import Catalog, CatalogIntegrityError, CatalogNotFoundError, catalog_path
from caemble_catalog.admin import (
    create_draft,
    publish_draft,
    refresh_derived_data,
    semantic_diff,
    validate_database,
    writable_connection,
)
from caemble_catalog.cli import main


def test_canonical_catalog_is_normalized_and_complete():
    with Catalog.open_readonly() as catalog:
        assert catalog.meta() == {
            "schemaVersion": 3,
            "catalogRevision": catalog.meta()["catalogRevision"],
            "quantityKindDataVersion": "0.0.1",
            "materialCatalogVersion": "0.0.0",
            "quantityKindCount": 1_216,
            "materialParameterCount": 258,
            "materialModelCount": 2,
            "solverCount": 2,
            "geometryCount": 7,
            "experimentCount": 4,
            "materialGlobalQualifiers": [
                "temperature",
                "pressure",
                "frequency",
                "wavelength",
                "phase",
                "composition",
                "material_state",
                "source",
                "measurement_or_derivation_method",
            ],
            "materialDesignRules": catalog.meta()["materialDesignRules"],
        }
        assert catalog._one("SELECT count(*) AS value FROM quantity_kind_units")["value"] == 10_338
        assert catalog._one("SELECT count(*) AS value FROM sqlite_schema WHERE name = 'solver_artifact_compatibility'")[
            "value"
        ] == 1
        strict = {
            row["name"]: row["strict"]
            for row in catalog._all("PRAGMA table_list")
            if row["type"] == "table" and not row["name"].startswith("sqlite_")
        }
        assert strict
        assert set(strict.values()) == {1}
        assert "descriptor_json" not in {
            row["name"] for row in catalog._all("PRAGMA table_info('solvers')")
        }


def test_solver_manifests_reconstruct_the_legacy_contract():
    with Catalog.open_readonly() as catalog:
        manifests = catalog.solver_manifests()
        assert [item["descriptor"]["name"] for item in manifests] == [
            "dc-current-density",
            "steady-state-heat",
        ]
        heat = catalog.get_solver_manifest("steady-state-heat", "0.1.0")
        assert heat["schemaVersion"] == 1
        assert heat["implementation"] == "app.solvers.steady_state_heat.solver:run"
        assert heat["descriptor"]["materials"][0]["properties"]["thermal.conductivity"]["data"] == {
            "dtype": "float64",
            "quantityKind": "thermodynamics.ThermalConductivity",
            "unit": "W.m-1.K-1",
            "basis": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        }
        assert len(catalog.solver_contract_digest("steady-state-heat", "0.1.0")) == 64


def test_example_geometry_and_experiment_catalog_contracts():
    with Catalog.open_readonly() as catalog:
        geometries, geometry_total = catalog.list_geometries(limit=100)
        experiments, experiment_total = catalog.list_experiments(limit=100)
        assert geometry_total == 7
        repositories = catalog.list_geometry_repositories()
        assert [item["slug"] for item in repositories] == [
            "getting-started",
            "arrays",
            "advanced-shapes",
            "assemblies",
        ]
        arrays, arrays_total = catalog.list_geometries(repository="arrays", limit=100)
        assert arrays_total == 2
        assert {item["key"] for item in arrays} == {
            "random-curved-edge-cylinder-array",
            "random-curved-surface-sphere-hcp-array",
        }
        assert experiment_total == 4
        assert {item["key"] for item in geometries} == {
            "basketball-goal",
            "fiber-bundle",
            "shell-cutaways",
            "random-curved-edge-cylinder-array",
            "random-curved-surface-sphere-hcp-array",
            "geometry-authoring-skeleton",
            "two-material-wheel-assembly",
        }
        wheel = catalog.geometry("two-material-wheel-assembly")
        assert wheel["repository"] == "assemblies"
        assert wheel["cadApiVersion"] == 8
        assert wheel["moduleFormatVersion"] == 4
        assert wheel["exportName"] == "WheelAssembly"
        assert [item["role"] for item in wheel["materialRoles"]] == ["tire", "wheel"]
        assert len(wheel["sourceHash"]) == 64

        coupled = catalog.experiment("electro-thermal-uniform-bar")
        assert coupled["sourceBundle"]["formatVersion"] == 5
        assert coupled["cadApiVersion"] == 8
        assert coupled["sourceFormatVersion"] == 2
        assert [(item["name"], item["version"]) for item in coupled["relatedSolvers"]] == [
            ("dc-current-density", "0.1.0"),
            ("steady-state-heat", "0.1.0"),
        ]
        assert set(coupled["sourceBundle"]["files"]) >= {
            "experiment.tsx",
            "geometry.tsx",
            "material.tsx",
            "simulate.py",
        }
        assert catalog.list_geometries(element="fiber", limit=100)[1] == 2
        assert catalog.list_experiments(solver_name="steady-state-heat", solver_version="0.1.0")[1] == 1
        assert {item["kind"] for item in catalog.search("wheel")} >= {"geometry"}


def test_geometry_and_experiment_cli_crud_and_semantic_diff(tmp_path: Path):
    baseline = tmp_path / "baseline.sqlite3"
    draft = tmp_path / "draft.sqlite3"
    shutil.copy2(catalog_path(), baseline)
    create_draft(draft, baseline)
    with Catalog.open_readonly(baseline, immutable=False) as catalog:
        geometry = catalog.geometry("basketball-goal")
        experiment = catalog.experiment("dc-uniform-bar")

    source = tmp_path / "geometry.tsx"
    source.write_text(geometry["source"], encoding="utf-8")
    assert main(
        [
            "--database", str(draft), "geometry", "upsert", geometry["key"],
            "--title", "Updated Basketball Goal", "--description", geometry["description"],
            "--length-unit", geometry["lengthUnit"], "--export-name", geometry["exportName"],
            "--source-file", str(source), "--element", "box", "--element", "cylinder", "--element", "subtract",
        ]
    ) == 0
    bundle = tmp_path / "bundle.json"
    verification = tmp_path / "verification.json"
    bundle.write_text(json.dumps(experiment["sourceBundle"], ensure_ascii=False), encoding="utf-8")
    verification.write_text(json.dumps(experiment["verification"], ensure_ascii=False), encoding="utf-8")
    assert main(
        [
            "--database", str(draft), "experiment", "upsert", experiment["key"],
            "--title", "Updated DC Uniform Bar", "--description", experiment["description"],
            "--bundle-file", str(bundle), "--verification-file", str(verification),
            "--solver", "dc-current-density@0.1.0",
        ]
    ) == 0
    validate_database(draft)
    assert semantic_diff(draft, baseline) == [
        "~ geometries/basketball-goal",
        "~ experiments/dc-uniform-bar",
    ]
    assert main(["--database", str(draft), "geometry", "remove", geometry["key"]]) == 0
    assert main(["--database", str(draft), "experiment", "remove", experiment["key"]]) == 0


def test_runtime_slice_is_solver_scoped_and_resolves_explicit_references():
    with Catalog.open_readonly() as catalog:
        result = catalog.runtime_slice(
            solvers=[("steady-state-heat", "0.1.0")],
            quantity_kinds=["Absorptance"],
            material_parameters=["general.mass_density"],
            material_models=["model.sorption.isotherm"],
        )
        assert result["schemaVersion"] == 1
        assert [item["name"] for item in result["solvers"]] == ["steady-state-heat"]
        assert "thermal.conductivity" in {item["key"] for item in result["materialParameters"]}
        assert "general.mass_density" in {item["key"] for item in result["materialParameters"]}
        quantity_names = {item["name"] for item in result["quantityKinds"]}
        assert {
            "Absorptance",
            "MassDensity",
            "PowerDensity",
            "thermodynamics.RelativeHumidity",
            "MassFraction",
            "thermodynamics.Temperature",
            "thermodynamics.ThermalConductivity",
        } <= quantity_names
        assert result["materialGlobalQualifiers"][0] == "temperature"
        assert any("Material model model.sorption.isotherm" in warning for warning in result["warnings"])

        with pytest.raises(CatalogNotFoundError, match="Unknown QuantityKind"):
            catalog.runtime_slice(solvers=[], quantity_kinds=["not.real"], material_parameters=[])


def test_contract_digest_changes_only_for_referenced_catalog_rows(tmp_path: Path):
    draft = tmp_path / "draft.sqlite3"
    create_draft(draft)
    with Catalog.open_readonly(draft, immutable=False) as catalog:
        original = catalog.solver_contracts()

    with writable_connection(draft) as connection:
        ordinal = connection.execute(
            "SELECT count(*) FROM quantity_kind_units WHERE quantity_kind = 'Absorptance'"
        ).fetchone()[0]
        connection.execute(
            "INSERT INTO quantity_kind_units VALUES ('Absorptance', ?, 'test.unrelated')",
            (ordinal,),
        )
    refresh_derived_data(draft)
    with Catalog.open_readonly(draft, immutable=False) as catalog:
        assert catalog.solver_contracts() == original

    with writable_connection(draft) as connection:
        ordinal = connection.execute(
            "SELECT count(*) FROM quantity_kind_units WHERE quantity_kind = 'thermodynamics.Temperature'"
        ).fetchone()[0]
        connection.execute(
            "INSERT INTO quantity_kind_units VALUES ('thermodynamics.Temperature', ?, 'test.referenced')",
            (ordinal,),
        )
    refresh_derived_data(draft)
    with Catalog.open_readonly(draft, immutable=False) as catalog:
        changed = catalog.solver_contracts()
        assert changed[("steady-state-heat", "0.1.0")] != original[("steady-state-heat", "0.1.0")]
        assert changed[("dc-current-density", "0.1.0")] == original[("dc-current-density", "0.1.0")]


def test_draft_diff_publish_and_released_solver_identity_policy(tmp_path: Path):
    baseline = tmp_path / "canonical.sqlite3"
    draft = tmp_path / "draft.sqlite3"
    shutil.copy2(catalog_path(), baseline)
    create_draft(draft, baseline)
    assert semantic_diff(draft, baseline) == []

    assert main(
        [
            "--database",
            str(draft),
            "solver",
            "set-metadata",
            "steady-state-heat",
            "0.1.0",
            "--description",
            "changed",
        ]
    ) == 0
    before = baseline.read_bytes()
    with pytest.raises(CatalogIntegrityError, match="immutable"):
        publish_draft(draft, baseline)
    assert baseline.read_bytes() == before

    create_draft(draft, baseline)
    assert main(
        ["--database", str(draft), "experiment", "remove", "electro-thermal-uniform-bar"]
    ) == 0
    assert main(
        [
            "--database",
            str(draft),
            "solver",
            "clone",
            "steady-state-heat",
            "0.1.0",
            "0.2.0",
        ]
    ) == 0
    publish_draft(draft, baseline)
    with Catalog.open_readonly(baseline, immutable=False) as catalog:
        assert ("steady-state-heat", "0.2.0") in catalog.solver_contracts()
        assert ("steady-state-heat", "0.1.0") not in catalog.solver_contracts()


def test_publish_does_not_replace_destination_with_invalid_database(tmp_path: Path):
    destination = tmp_path / "canonical.sqlite3"
    invalid = tmp_path / "invalid.sqlite3"
    shutil.copy2(catalog_path(), destination)
    shutil.copy2(catalog_path(), invalid)
    connection = sqlite3.connect(invalid)
    connection.execute("PRAGMA application_id = 0")
    connection.close()
    before = destination.read_bytes()
    with pytest.raises(CatalogIntegrityError):
        publish_draft(invalid, destination)
    assert destination.read_bytes() == before


def test_validate_detects_stale_contract_digest(tmp_path: Path):
    draft = tmp_path / "draft.sqlite3"
    create_draft(draft)
    connection = sqlite3.connect(draft)
    connection.execute("UPDATE solvers SET contract_digest = ?", ("f" * 64,))
    connection.commit()
    connection.close()
    with pytest.raises(CatalogIntegrityError, match="Contract digest mismatch"):
        validate_database(draft)


@pytest.mark.parametrize(
    ("statement", "match"),
    [
        (
            "UPDATE geometries SET source_hash = '0000000000000000000000000000000000000000000000000000000000000000' "
            "WHERE key = 'basketball-goal'",
            "Geometry basketball-goal source hash mismatch",
        ),
        (
            "UPDATE experiment_files SET path = 'missing.py' "
            "WHERE experiment_key = 'dc-uniform-bar' AND path = 'simulate.py'",
            "Experiment dc-uniform-bar source bundle is missing required files",
        ),
        (
            "UPDATE experiments SET verification_json = '{}' WHERE key = 'dc-uniform-bar'",
            "Experiment dc-uniform-bar verification.kernelTasks must be a string array",
        ),
        (
            "UPDATE experiment_solvers SET solver_version = '9.9.9' "
            "WHERE experiment_key = 'dc-uniform-bar'",
            "foreign-key violation",
        ),
    ],
)
def test_validate_rejects_invalid_official_source_bundle_and_solver_relations(
    tmp_path: Path,
    statement: str,
    match: str,
):
    draft = tmp_path / "invalid.sqlite3"
    create_draft(draft)
    connection = sqlite3.connect(draft)
    connection.execute(statement)
    connection.commit()
    connection.close()

    with pytest.raises(CatalogIntegrityError, match=match):
        validate_database(draft)
