import copy
import json
import sys

import pytest

import app.solvers
from app.errors import CaeError
from app.solver_framework.registry import SolverRegistry, registry


def write_solver(root, directory, *, name, implementation=None):
    solver_directory = root / directory
    solver_directory.mkdir(parents=True)
    manifest = copy.deepcopy(registry.manifests()[0])
    manifest["implementation"] = implementation or f"app.solvers.{directory}.solver:run"
    manifest["descriptor"]["name"] = name
    (solver_directory / "manifest.json").write_text(
        json.dumps(manifest),
        encoding="utf-8",
    )
    return solver_directory


def test_production_manifests_are_schema_valid_and_implementations_stay_lazy():
    modules_before = set(sys.modules)
    discovered = SolverRegistry.discover()

    assert [manifest["descriptor"]["name"] for manifest in discovered.manifests()] == [
        "dc-current-density",
        "steady-state-heat",
    ]
    assert "app.solvers.dc_current_density.solver" not in set(sys.modules) - modules_before
    assert "app.solvers.steady_state_heat.solver" not in set(sys.modules) - modules_before


def test_registry_rejects_duplicate_identity(tmp_path):
    root = tmp_path / "solvers"
    first = write_solver(root, "first", name="test-one")
    second = write_solver(root, "second", name="test-one")
    (first / "solver.py").write_text("async def run(context): return {}\n", encoding="utf-8")
    (second / "solver.py").write_text("async def run(context): return {}\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="Duplicate CAE kernel identity"):
        SolverRegistry.discover(root)


def test_registry_rejects_malformed_or_missing_implementation(tmp_path):
    root = tmp_path / "solvers"
    write_solver(root, "broken", name="broken")

    with pytest.raises(RuntimeError, match="implementation file is missing"):
        SolverRegistry.discover(root)


def test_registry_rejects_manifest_schema_violation(tmp_path):
    root = tmp_path / "solvers"
    solver_directory = write_solver(root, "invalid", name="invalid")
    manifest_path = solver_directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["schemaVersion"] = 2
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    (solver_directory / "solver.py").write_text("async def run(context): return {}\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="Invalid CAE solver manifest"):
        SolverRegistry.discover(root)


def test_registry_rejects_malformed_implementation_reference(tmp_path):
    root = tmp_path / "solvers"
    solver_directory = write_solver(
        root,
        "invalid",
        name="invalid",
        implementation="not-a-module",
    )
    (solver_directory / "solver.py").write_text("async def run(context): return {}\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="Invalid CAE solver manifest"):
        SolverRegistry.discover(root)


@pytest.mark.asyncio
async def test_test_only_solver_is_discovered_and_run_without_central_registration(tmp_path, monkeypatch):
    root = tmp_path / "solvers"
    solver_directory = write_solver(root, "test_echo", name="test-echo")
    (solver_directory / "__init__.py").write_text("", encoding="utf-8")
    (solver_directory / "solver.py").write_text(
        "async def run(context):\n"
        "    return {'artifacts': {'echo': context.config['value']}, 'observations': {}}\n",
        encoding="utf-8",
    )
    module_name = "app.solvers.test_echo.solver"
    sys.modules.pop(module_name, None)
    monkeypatch.setattr(app.solvers, "__path__", [*app.solvers.__path__, str(root)])
    discovered = SolverRegistry.discover(root)

    assert module_name not in sys.modules
    result = await discovered.run(
        {
            "kernel": {"name": "test-echo", "version": "0.0.0"},
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
