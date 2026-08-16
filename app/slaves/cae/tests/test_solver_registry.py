import copy
import sys
from pathlib import Path

import pytest

import app.solvers
from app.errors import CaeError
from app.solver_framework.registry import SolverRegistry, registry

TEST_DIGEST = "1" * 64
CAE_APP = Path(__file__).resolve().parents[1] / "app"


def solver_manifest(directory, *, name, implementation=None):
    manifest = copy.deepcopy(registry.manifests()[0])
    manifest["implementation"] = implementation or f"app.solvers.{directory}.solver:run"
    manifest["descriptor"]["name"] = name
    return manifest


def write_implementation(root, directory, source="async def run(context): return {}\n"):
    solver_directory = root / directory
    solver_directory.mkdir(parents=True)
    (solver_directory / "__init__.py").write_text("", encoding="utf-8")
    (solver_directory / "solver.py").write_text(source, encoding="utf-8")
    return solver_directory


def digests(*manifests):
    return {
        (manifest["descriptor"]["name"], manifest["descriptor"]["version"]): TEST_DIGEST
        for manifest in manifests
    }


def test_production_catalog_contracts_are_valid_and_implementations_stay_lazy():
    modules_before = set(sys.modules)
    discovered = SolverRegistry.discover()

    assert [manifest["descriptor"]["name"] for manifest in discovered.manifests()] == [
        "dc-current-density",
        "steady-state-heat",
    ]
    for manifest in discovered.manifests():
        descriptor = manifest["descriptor"]
        assert len(discovered.contract_digest(descriptor["name"], descriptor["version"])) == 64
    assert "app.solvers.dc_current_density.solver" not in set(sys.modules) - modules_before
    assert "app.solvers.steady_state_heat.solver" not in set(sys.modules) - modules_before


def test_solver_contracts_are_not_duplicated_as_json_files():
    assert list((CAE_APP / "solvers").glob("*/manifest.json")) == []
    assert not (CAE_APP / "solver_framework" / "solver-manifest.schema.json").exists()


def test_registry_rejects_duplicate_identity(tmp_path):
    root = tmp_path / "solvers"
    first = solver_manifest("first", name="test-one")
    second = solver_manifest("second", name="test-one")
    write_implementation(root, "first")
    write_implementation(root, "second")

    with pytest.raises(RuntimeError, match="Duplicate CAE kernel identity"):
        SolverRegistry.from_manifests([first, second], digests(first), solvers_root=root)


def test_registry_rejects_missing_implementation(tmp_path):
    manifest = solver_manifest("broken", name="broken")

    with pytest.raises(RuntimeError, match="implementation file is missing"):
        SolverRegistry.from_manifests(
            [manifest],
            digests(manifest),
            solvers_root=tmp_path / "solvers",
        )


def test_registry_rejects_invalid_reconstructed_manifest(tmp_path):
    root = tmp_path / "solvers"
    manifest = solver_manifest("invalid", name="invalid")
    manifest["schemaVersion"] = 2
    write_implementation(root, "invalid")

    with pytest.raises(RuntimeError, match="Invalid CAE solver manifest reconstructed from catalog"):
        SolverRegistry.from_manifests([manifest], digests(manifest), solvers_root=root)


def test_registry_rejects_malformed_implementation_reference(tmp_path):
    manifest = solver_manifest("invalid", name="invalid", implementation="not-a-module")

    with pytest.raises(RuntimeError, match="Invalid CAE solver manifest reconstructed from catalog"):
        SolverRegistry.from_manifests(
            [manifest],
            digests(manifest),
            solvers_root=tmp_path / "solvers",
        )


def test_registry_rejects_missing_or_extra_contract_digest(tmp_path):
    root = tmp_path / "solvers"
    manifest = solver_manifest("test_echo", name="test-echo")
    write_implementation(root, "test_echo")

    with pytest.raises(RuntimeError, match="Invalid CAE solver contract digest"):
        SolverRegistry.from_manifests([manifest], {}, solvers_root=root)

    with pytest.raises(RuntimeError, match="manifests and contract digests do not match"):
        SolverRegistry.from_manifests(
            [manifest],
            {**digests(manifest), ("unexpected", "0.1.0"): TEST_DIGEST},
            solvers_root=root,
        )


@pytest.mark.asyncio
async def test_test_only_solver_is_loaded_lazily_and_run_from_catalog_contract(tmp_path, monkeypatch):
    root = tmp_path / "solvers"
    manifest = solver_manifest("test_echo", name="test-echo")
    write_implementation(
        root,
        "test_echo",
        "async def run(context):\n"
        "    return {'artifacts': {'echo': context.config['value']}, 'observations': {}}\n",
    )
    module_name = "app.solvers.test_echo.solver"
    sys.modules.pop(module_name, None)
    monkeypatch.setattr(app.solvers, "__path__", [*app.solvers.__path__, str(root)])
    discovered = SolverRegistry.from_manifests(
        [manifest],
        digests(manifest),
        solvers_root=root,
    )

    assert module_name not in sys.modules
    result = await discovered.run(
        {
            "kernel": {"name": "test-echo", "version": "0.1.0"},
            "config": {"value": 7},
        },
        {"revision": 1},
        {},
        {},
        lambda _value: None,
    )

    assert module_name in sys.modules
    assert result == {
        "state": {"revision": 1},
        "artifacts": {"echo": 7},
        "observations": {},
    }


def test_registry_reports_unknown_kernel_with_stable_error_code():
    with pytest.raises(CaeError) as error:
        registry.descriptor("missing", "0.0.0")

    assert error.value.code == "kernel_not_found"
