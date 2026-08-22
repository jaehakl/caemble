from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from pathlib import Path

import pytest

from caemble_catalog import (
    Catalog,
    CatalogAmbiguousError,
    CatalogIntegrityError,
    CatalogNotFoundError,
    catalog_path,
)
from caemble_catalog.admin import (
    create_draft,
    publish_draft,
    refresh_derived_data,
    semantic_diff,
    validate_database,
    writable_connection,
)
from caemble_catalog.cli import main
from caemble_catalog.experiment_bundle import ExperimentBundleError, validate_experiment_module_graph
from caemble_catalog.schema import parse_experiment_version


def test_canonical_catalog_is_normalized_and_complete():
    with Catalog.open_readonly() as catalog:
        assert catalog.meta() == {
            "schemaVersion": 4,
            "catalogRevision": catalog.meta()["catalogRevision"],
            "quantityKindDataVersion": "0.0.1",
            "materialCatalogVersion": "0.0.0",
            "quantityKindCount": 1_216,
            "materialParameterCount": 258,
            "materialModelCount": 2,
            "solverCount": 2,
            "experimentCount": 11,
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
        experiment_columns = {row["name"]: row for row in catalog._all("PRAGMA table_info('experiments')")}
        assert experiment_columns["id"]["pk"] == 1
        assert experiment_columns["key"]["pk"] == 0
        assert {
            (row["from"], row["to"])
            for row in catalog._all("PRAGMA foreign_key_list('experiment_files')")
        } == {("experiment_id", "id")}


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


def test_official_experiment_catalog_contracts():
    with Catalog.open_readonly() as catalog:
        experiments, experiment_total = catalog.list_experiments(limit=100)
        assert experiment_total == 11
        assert {
            "basketball-goal",
            "fiber-bundle",
            "shell-cutaways",
            "random-curved-edge-cylinder-array",
            "random-curved-surface-sphere-hcp-array",
            "geometry-authoring-skeleton",
            "two-material-wheel-assembly",
        } < {item["key"] for item in experiments}
        assert catalog._all("SELECT name FROM sqlite_schema WHERE name LIKE '%geometr%'") == []

        wheel = catalog.experiment("two-material-wheel-assembly")
        assert wheel["namespace"] == "caemble"
        assert wheel["repository"] == "assemblies"
        assert wheel["version"] == "1.0.0"
        assert wheel["coordinate"] == "caemble:experiment/caemble/assemblies/two-material-wheel-assembly@1.0.0"
        assert wheel["cadApiVersion"] == 8
        assert wheel["sourceBundle"]["formatVersion"] == 6
        assert not any(path.startswith("tasks/") for path in wheel["sourceBundle"]["files"])
        assert wheel["relatedSolvers"] == []
        assert catalog.list_experiments(namespace="caemble", repository="arrays", limit=100)[1] == 2

        coupled = catalog.experiment("electro-thermal-uniform-bar")
        assert coupled["sourceBundle"]["formatVersion"] == 6
        assert "geometrySnapshot" not in coupled["sourceBundle"]
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
        assert catalog.list_experiments(solver_name="steady-state-heat", solver_version="0.1.0")[1] == 1
        assert {item["kind"] for item in catalog.search("wheel")} == {"experiment"}


@pytest.mark.parametrize("value", ["01.0.0", "1.00.0", "1.0.0-alpha", "2147483648.0.0"])
def test_experiment_versions_are_bounded_release_only_semver(value: str):
    with pytest.raises(ValueError):
        parse_experiment_version(value)
    with Catalog.open_readonly() as catalog:
        with pytest.raises(CatalogNotFoundError):
            catalog.experiment("basketball-goal", version=value)

    assert parse_experiment_version("2147483647.0.0") == (2_147_483_647, 0, 0)


def test_experiment_cli_crud_and_semantic_diff(tmp_path: Path, capsys):
    baseline = tmp_path / "baseline.sqlite3"
    draft = tmp_path / "draft.sqlite3"
    shutil.copy2(catalog_path(), baseline)
    create_draft(draft, baseline)
    with Catalog.open_readonly(baseline, immutable=False) as catalog:
        experiment = catalog.experiment("basketball-goal")

    bundle = tmp_path / "bundle.json"
    verification = tmp_path / "verification.json"
    bundle.write_text(json.dumps(experiment["sourceBundle"], ensure_ascii=False), encoding="utf-8")
    verification.write_text(json.dumps(experiment["verification"], ensure_ascii=False), encoding="utf-8")
    assert main(
        [
            "--database", str(draft), "experiment", "upsert", experiment["key"],
            "--namespace", experiment["namespace"], "--repository", experiment["repository"],
            "--version", experiment["version"],
            "--title", "Updated Basketball Goal", "--description", experiment["description"],
            "--bundle-file", str(bundle), "--verification-file", str(verification),
        ]
    ) == 0
    validate_database(draft)
    assert semantic_diff(draft, baseline) == [f"~ experiments/{experiment['coordinate']}"]

    second_version_args = [
        "--database", str(draft), "experiment", "upsert", experiment["key"],
        "--namespace", experiment["namespace"], "--repository", experiment["repository"],
        "--version", "2.0.0", "--title", experiment["title"], "--description", experiment["description"],
        "--bundle-file", str(bundle), "--verification-file", str(verification),
    ]
    assert main(second_version_args) == 0
    fork_args = second_version_args.copy()
    fork_args[fork_args.index("--namespace") + 1] = "forked"
    fork_args[fork_args.index("--repository") + 1] = "examples"
    fork_args[fork_args.index("--version") + 1] = "1.0.0"
    assert main(fork_args) == 0
    with Catalog.open_readonly(draft, immutable=False) as catalog:
        with pytest.raises(CatalogAmbiguousError, match="provide namespace, repository, and version"):
            catalog.experiment(experiment["key"])
        selected = catalog.experiment(
            experiment["key"],
            namespace=experiment["namespace"],
            repository=experiment["repository"],
            version="2.0.0",
        )
        assert catalog.experiment(selected["coordinate"])["version"] == "2.0.0"
        matches = catalog.list_experiments(query=experiment["key"], limit=100)[0]
        assert {item["coordinate"] for item in matches} == {
            experiment["coordinate"],
            "caemble:experiment/caemble/getting-started/basketball-goal@2.0.0",
            "caemble:experiment/forked/examples/basketball-goal@1.0.0",
        }
    capsys.readouterr()
    assert main(
        [
            "--database", str(draft), "query", "experiment", experiment["key"], "2.0.0",
            "--namespace", experiment["namespace"], "--repository", experiment["repository"],
        ]
    ) == 0
    assert json.loads(capsys.readouterr().out)["coordinate"].endswith("@2.0.0")
    assert main(["--database", str(draft), "query", "experiment", selected["coordinate"]]) == 0
    assert json.loads(capsys.readouterr().out)["coordinate"] == selected["coordinate"]
    assert main(["--database", str(draft), "experiment", "remove", experiment["key"]]) == 1
    assert main(["--database", str(draft), "experiment", "remove", selected["coordinate"]]) == 0
    assert main(
        [
            "--database", str(draft), "experiment", "remove", experiment["key"],
            "--namespace", "forked", "--repository", "examples", "--version", "1.0.0",
        ]
    ) == 0
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
    with Catalog.open_readonly(draft, immutable=False) as catalog:
        assert [
            item["name"] for item in catalog.experiment("electro-thermal-uniform-bar")["relatedSolvers"]
        ] == ["dc-current-density", "steady-state-heat"]
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
            "UPDATE experiments SET bundle_hash = '0000000000000000000000000000000000000000000000000000000000000000' "
            "WHERE key = 'basketball-goal'",
            "Experiment basketball-goal bundle hash mismatch",
        ),
        (
            "UPDATE experiment_files SET path = 'missing.py' "
            "WHERE experiment_id = (SELECT id FROM experiments WHERE key = 'dc-uniform-bar') "
            "AND path = 'simulate.py'",
            "Experiment dc-uniform-bar source bundle is missing required files",
        ),
        (
            "UPDATE experiments SET verification_json = '{}' WHERE key = 'dc-uniform-bar'",
            "Experiment dc-uniform-bar verification.kernelTasks must be a string array",
        ),
        (
            "UPDATE experiment_solvers SET solver_version = '9.9.9' "
            "WHERE experiment_id = (SELECT id FROM experiments WHERE key = 'dc-uniform-bar')",
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


def test_official_experiment_module_policy_accepts_ts_syntax_and_type_only_cycles():
    files = {
        "experiment.tsx": "import { value } from './lib/value'\nexport default value\n",
        "geometry.tsx": "export {}\n",
        "material.tsx": "export {}\n",
        "simulate.py": "async def simulate(*, sim, tasks, vars): pass\n",
        "lib/value.ts": (
            "import type { Other } from './other'\n"
            "export type Value = { other?: Other }\n"
            "export const value = <number>1\n"
        ),
        "lib/other.ts": "import type { Value } from './value'\nexport type Other = { value?: Value }\n",
    }

    validate_experiment_module_graph(files)


def test_official_experiment_module_policy_resolves_dotted_extensionless_paths():
    validate_experiment_module_graph(
        {
            "entry.ts": "import { value } from './lib/value.helpers'\nexport { value }\n",
            "lib/value.helpers.ts": "export const value = 1\n",
        }
    )


def test_official_experiment_module_policy_uses_structural_type_modifiers():
    validate_experiment_module_graph(
        {
            "types/a.ts": "import { type\n B } from './b'\nexport type A = B\n",
            "types/b.ts": "import { type /* comment */ A } from './a'\nexport type B = A\n",
        }
    )

    with pytest.raises(ExperimentBundleError, match="Runtime bundle import cycle"):
        validate_experiment_module_graph(
            {
                "runtime/a.ts": (
                    "import { type as b } from './b'\n"
                    "export const type = b\n"
                ),
                "runtime/b.ts": (
                    "import { type as a } from './a'\n"
                    "export const type = a\n"
                ),
            }
        )


@pytest.mark.parametrize(
    ("source", "match"),
    [
        ("import './missing'\n", "not found"),
        ("void import('./value')\n", "Dynamic import"),
        ("const value = <number>1\n", "TSX syntax error"),
    ],
)
def test_official_experiment_module_policy_rejects_non_executable_graphs(source: str, match: str):
    files = {
        "experiment.tsx": "export default null\n",
        "geometry.tsx": "export {}\n",
        "material.tsx": "export {}\n",
        "simulate.py": "async def simulate(*, sim, tasks, vars): pass\n",
        "lib/value.tsx": source,
    }

    with pytest.raises(ExperimentBundleError, match=match):
        validate_experiment_module_graph(files)


def test_catalog_validation_applies_official_experiment_module_policy(tmp_path: Path):
    draft = tmp_path / "invalid-import.sqlite3"
    create_draft(draft)
    connection = sqlite3.connect(draft)
    connection.execute(
        """UPDATE experiment_files SET source = 'import ''./missing''; export {}'
           WHERE experiment_id = (SELECT id FROM experiments WHERE key = 'basketball-goal')
             AND path = 'geometry.tsx'"""
    )
    connection.commit()
    connection.close()

    with pytest.raises(CatalogIntegrityError, match="Bundle import is not found"):
        validate_database(draft)


def test_catalog_validation_accepts_shared_source_path_rules(tmp_path: Path):
    draft = tmp_path / "dotted-path.sqlite3"
    create_draft(draft)
    connection = sqlite3.connect(draft)
    experiment_id, format_version = connection.execute(
        "SELECT id, bundle_format_version FROM experiments WHERE key = 'basketball-goal'"
    ).fetchone()
    source_rows = connection.execute(
        "SELECT path, source FROM experiment_files WHERE experiment_id = ? ORDER BY ordinal",
        (experiment_id,),
    ).fetchall()
    files = {path: source for path, source in source_rows}
    files["lib/value..helpers.ts"] = "export const value = 1\n"
    connection.execute(
        "INSERT INTO experiment_files(experiment_id, ordinal, path, source) VALUES (?, ?, ?, ?)",
        (experiment_id, len(source_rows), "lib/value..helpers.ts", files["lib/value..helpers.ts"]),
    )
    bundle_json = json.dumps(
        {"formatVersion": format_version, "files": files},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    connection.execute(
        "UPDATE experiments SET bundle_hash = ? WHERE id = ?",
        (hashlib.sha256(bundle_json.encode("utf-8")).hexdigest(), experiment_id),
    )
    connection.commit()
    connection.close()

    refresh_derived_data(draft)
    validate_database(draft)
