"""Cost-aware selection and reporting without collecting unrelated solver tests."""

import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from tests.reporting import ProgressReport
from tests.selection import CAE_PREFIX, changed_paths, collection_targets, excluded_function_targets, select_changes, selected_item


REPO = Path(__file__).resolve().parents[4]
CAE = REPO / "app/slaves/cae"


def item(nodeid, *, validation=False, **parameters):
    return SimpleNamespace(nodeid=nodeid, originalname=nodeid.split("::")[-1].split("[")[0],
                           callspec=SimpleNamespace(params=parameters),
                           get_closest_marker=lambda name: True if name == "validation" and validation else None)


def test_sph_output_selects_particle_consumers_without_fem_convergence():
    selection = select_changes([CAE_PREFIX + "app/solvers/sph/outputs.py"])
    assert selected_item(item("tests/test_sph_outputs.py::test_pressure"), selection, {})
    assert selected_item(item("tests/test_particle_runtime.py::test_record[sph]", particle_measurement="sph-hydrostatic-column"), selection, {}, {"lowcost", "smoke"})
    assert not selected_item(item("tests/test_particle_runtime.py::test_record[mpm]", particle_measurement="mpm-affine-compression"), selection, {})
    assert not selected_item(item("tests/test_particle_mpm.py::test_gravity"), selection, {})
    assert not selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), selection, {})
    sph_validation = item("tests/test_particle_sph_validation.py::test_periodic_channel_reaches_analytic_steady_profile_under_refinement")
    assert not selected_item(sph_validation, selection, {})
    assert selected_item(sph_validation, selection, {}, {"validation"})
    for owner in ("dem", "mpm"):
        other = select_changes([CAE_PREFIX + f"app/solvers/{owner}/outputs.py"])
        assert not selected_item(sph_validation, other, {}, {"validation"})
    assert selection.actions == {"python-static"}


def test_shared_constitutive_method_selects_fem_mpm_and_validation():
    selection = select_changes([CAE_PREFIX + "app/methods/continuum/hyperelastic.py"])
    assert selection.solvers == {"structural_mechanics", "mpm"}
    assert not selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), selection, {})
    assert selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), selection, {}, {"validation"})
    assert selected_item(item("tests/test_particle_mpm.py::test_gravity"), selection, {})


@pytest.mark.parametrize("path", ["finite_volume/tetrahedral.py", "coupling/tetrahedral.py"])
def test_tetrahedral_flow_methods_select_cfd_validation_without_unrelated_convergence(path):
    selection = select_changes([CAE_PREFIX + "app/methods/" + path, "app/catalog/caemble_catalog/catalog.sqlite3"])
    assert selection.solvers == {"incompressible_flow"} and selection.all_components
    assert not selected_item(item("tests/test_incompressible_physics.py::test_duct_convergence", validation=True), selection, {})
    focused = select_changes([CAE_PREFIX + "app/methods/" + path])
    assert selected_item(item("tests/test_incompressible_physics.py::test_duct_convergence", validation=True), focused, {}, {"validation"}, tier="validation")
    assert not selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), focused, {}, {"validation"})
    assert not selected_item(item("tests/test_pressure_acoustics.py::test_convergence", validation=True), focused, {}, {"validation"})
    shared = select_changes([CAE_PREFIX + "app/methods/coupling/surface.py"])
    assert "structural_mechanics" in shared.solvers


def test_transient_flow_selects_its_convergence_and_outputs_keep_quick_scope():
    numerical = select_changes([CAE_PREFIX + "app/solvers/incompressible_flow/transient.py"])
    output = select_changes([CAE_PREFIX + "app/solvers/incompressible_flow/outputs.py"])
    convergence = item("tests/test_incompressible_transient_physics.py::test_time_convergence", validation=True)
    assert not selected_item(convergence, numerical, {})
    assert selected_item(convergence, numerical, {}, {"validation"}, tier="validation")
    assert not selected_item(convergence, output, {})
    assert selected_item(item("tests/test_incompressible_runtime.py::test_checkpoint"), output, {}, {"smoke"})


def test_kernel_change_covers_real_children_without_long_physics():
    selection = select_changes([CAE_PREFIX + "app/kernel/coordinator/contracts.py"])
    for filename in ("test_particle_field_handoff", "test_mmap_executor", "test_rigid_runtime", "test_acoustic_transient_lifecycle"):
        assert selected_item(item(f"tests/{filename}.py::test_case"), selection, {}, {"lowcost", "smoke"})
    assert not selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), selection, {})


def test_changed_test_does_not_enable_unrelated_validation():
    selection = select_changes([CAE_PREFIX + "app/methods/fields/box_grid.py", CAE_PREFIX + "tests/test_sph_outputs.py"])
    assert not selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), selection, {})
    direct = select_changes([CAE_PREFIX + "tests/test_mixed_benchmarks.py"])
    assert not selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), direct, {})
    assert selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), direct, {}, {"validation"})


def test_catalog_and_docs_have_explicit_external_checks():
    catalog = select_changes(["app/catalog/caemble_catalog/catalog.sqlite3"])
    assert catalog.all_components and catalog.actions == {"catalog", "examples", "python-static"}
    assert not selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), catalog, {})
    docs = select_changes(["docs/development/particles.md"])
    assert docs.actions == {"docs"} and not docs.all_components and not docs.patterns


def test_ui_layout_does_not_select_cae_or_rebuild_catalog_examples():
    layout = select_changes(["app/ui/src/features/viewer/ViewerLayout.tsx"])
    assert not layout.all_components and not layout.solvers and not layout.patterns
    assert layout.actions == {"ui-static"}
    authoring = select_changes(["app/ui/src/lib/cad/compiler/buildMeasurement.ts"])
    assert authoring.actions == {"ui-static", "examples"} and not authoring.all_components


def test_lowcost_preselection_excludes_heavy_modules_and_preserves_explicit_tiers():
    selection = select_changes([CAE_PREFIX + "tests/test_mixed_benchmarks.py"])
    targets, excluded = collection_targets(selection, {"lowcost"})
    assert targets == [] and "tests/test_mixed_benchmarks.py" in excluded
    targets, excluded = collection_targets(selection, {"lowcost", "validation"})
    assert targets == ["tests/test_mixed_benchmarks.py"] and not excluded


def test_missing_and_stale_cost_ownership_fail_without_collecting(monkeypatch):
    from tests.tiers import MODULE_TIERS

    monkeypatch.delitem(MODULE_TIERS, "tests/test_regression_runner.py")
    with pytest.raises(ValueError, match="Missing test cost ownership: tests/test_regression_runner.py"):
        collection_targets(None, {"lowcost"})
    monkeypatch.setitem(MODULE_TIERS, "tests/test_regression_runner.py", "lowcost")
    monkeypatch.setitem(MODULE_TIERS, "tests/test_removed.py", "smoke")
    with pytest.raises(ValueError, match="Stale test cost ownership: tests/test_removed.py"):
        collection_targets(None, {"lowcost"})


def test_unrun_mixed_validation_is_reported_only_for_affected_owners():
    flow = select_changes([CAE_PREFIX + "app/solvers/incompressible_flow/outputs.py"])
    targets, _ = collection_targets(flow, {"lowcost"})
    excluded = excluded_function_targets(targets, flow, {"lowcost"})
    assert "tests/test_incompressible_physics.py::test_irregular_pressure_duct_converges_to_square_duct_reference" in excluded
    sph = select_changes([CAE_PREFIX + "app/solvers/sph/outputs.py"])
    targets, _ = collection_targets(sph, {"lowcost"})
    assert not any("test_particle_mpm" in key for key in excluded_function_targets(targets, sph, {"lowcost"}))
    heat = select_changes([CAE_PREFIX + "app/solvers/heat_transfer/entry.py"])
    allowed = {"lowcost", "smoke"}
    targets, _ = collection_targets(heat, allowed)
    assert "tests/test_microheater.py::test_microheater_voltage_linewidth_and_refinement" in excluded_function_targets(targets, heat, allowed)


def test_unknown_example_key_reports_a_selection_error_without_running(tmp_path):
    result = subprocess.run([sys.executable, "-m", "tests.run", "examples", "--key", "no-such-catalog-example",
                             "--list", "--report", str(tmp_path / "report")],
                            cwd=CAE, capture_output=True, text=True, encoding="utf-8")
    assert result.returncode == 2 and "no-such-catalog-example" in result.stderr
    assert "Traceback" not in result.stderr and not (tmp_path / "report").exists()


def test_explicit_absolute_validation_target_requires_opt_in_before_collection(tmp_path):
    result = subprocess.run([sys.executable, "-m", "tests.run", "affected", "--list", "--tests",
                             str(CAE / "tests/test_mixed_benchmarks.py"), "--report", str(tmp_path / "report")],
                            cwd=CAE, capture_output=True, text=True, encoding="utf-8")
    assert result.returncode == 2 and "requires --validation" in result.stderr
    assert not (tmp_path / "report").exists()


def test_explicit_target_skips_diff_actions_and_unselected_module_imports(tmp_path):
    report = tmp_path / "report"
    target = "tests/test_regression_runner.py::test_ui_layout_does_not_select_cae_or_rebuild_catalog_examples"
    script = ("import sys\nfrom unittest.mock import patch\nfrom tests.run import main\n"
              "with patch('tests.run.changed_paths', side_effect=AssertionError('must not inspect unrelated changes')):\n"
              f"    status = main(['affected', '--jobs', '1', '--tests', {target!r}, '--report', {str(report)!r}])\n"
              "assert 'tests.test_catalog_examples' not in sys.modules\nraise SystemExit(status)\n")
    result = subprocess.run([sys.executable, "-c", script], cwd=CAE, capture_output=True, text=True, encoding="utf-8")
    assert result.returncode == 0, result.stdout + result.stderr
    summary = json.loads((report / "summary.json").read_text(encoding="utf-8"))
    assert summary["outcomes"]["passed"] == 1 and summary["productSolvers"]["count"] == 0
    assert json.loads((report / "invocation.json").read_text(encoding="utf-8"))["actions"] == []


@pytest.mark.parametrize("target", [".", "../", "tests", "tests/solver_fixtures.py"])
def test_explicit_targets_cannot_expand_to_directories_or_unregistered_files(tmp_path, target):
    result = subprocess.run([sys.executable, "-m", "tests.run", "quick", "--list", "--tests", target,
                             "--report", str(tmp_path / "report")], cwd=CAE, capture_output=True, text=True, encoding="utf-8")
    assert result.returncode == 2 and "requires a registered CAE test file" in result.stderr
    assert not (tmp_path / "report").exists()


def test_collection_only_rejects_import_time_product_entry(tmp_path):
    probe = tmp_path / "test_import_time.py"
    probe.write_text('import asyncio\nimport pytest\nfrom app.kernel.api import SolverImplementation, SolverResult\n'
                     'pytestmark = pytest.mark.smoke\nasync def entry(invocation):\n    return SolverResult()\n'
                     'entry.__module__ = "app.solvers.synthetic.entry"\n'
                     'asyncio.run(SolverImplementation(3, entry)(None))\n'
                     'def test_unreachable():\n    pass\n', encoding="utf-8")
    report = tmp_path / "report"
    result = subprocess.run([sys.executable, "-m", "pytest", str(probe), "--collect-only", "-q", "-n", "0",
                             "-c", str(CAE / "pyproject.toml"), "-p", "tests.reporting", "--cae-suite=quick",
                             "--cae-tiers=lowcost,smoke", f"--cae-report={report}"],
                            cwd=CAE, capture_output=True, text=True, encoding="utf-8")
    assert result.returncode == 2 and "collection checks must not invoke product Solver" in result.stdout
    summary = json.loads((report / "summary.json").read_text(encoding="utf-8"))
    assert summary["productSolvers"]["count"] == 0 and len(summary["productSolvers"]["blocked"]) == 1


def test_unknown_cae_code_fails_and_current_source_ownership_is_complete():
    with pytest.raises(ValueError, match="No CAE test ownership"):
        select_changes([CAE_PREFIX + "app/solvers/new_physics/entry.py"])
    paths = [path.relative_to(REPO).as_posix() for path in (CAE / "app").rglob("*.py")]
    assert set(select_changes(paths).reasons) == set(paths)


def test_fixture_changes_select_only_their_consumers_even_with_validation_enabled():
    selection = select_changes([CAE_PREFIX + "tests/microheater_fixtures.py"])
    targets, _ = collection_targets(selection, {"lowcost", "smoke", "validation"})
    assert not selection.all_components
    assert "tests/test_microheater_contracts.py" in targets
    assert "tests/test_microheater_validation.py" in targets
    assert not any("mixed_benchmarks" in name or "incompressible" in name for name in targets)
    flow = select_changes([CAE_PREFIX + "tests/flow_fixtures.py"])
    targets, _ = collection_targets(flow, {"lowcost", "smoke", "validation"})
    assert targets and all("incompressible" in name for name in targets)
    catalog = select_changes([CAE_PREFIX + "tests/catalog_example_fixtures.py"])
    consumer = item("tests/test_catalog_examples.py::test_boolean_vars_rebuild_mesh_and_preserve_semantic_boundaries")
    assert selected_item(consumer, catalog, {}, {"lowcost", "smoke"})
    assert not selected_item(consumer, catalog, {}, {"lowcost"})
    sph = select_changes([CAE_PREFIX + "tests/sph_fixtures.py"])
    targets, _ = collection_targets(sph, {"lowcost", "validation"})
    assert targets == ["tests/test_particle_sph.py", "tests/test_particle_sph_validation.py"]


def test_support_ownership_is_explicit_and_covers_imported_helpers():
    paths = [path.relative_to(REPO).as_posix() for path in (CAE / "tests").rglob("*.py")]
    assert set(select_changes(paths).reasons) == set(paths)
    with pytest.raises(ValueError, match="No CAE test ownership"):
        select_changes([CAE_PREFIX + "tests/new_unowned_fixture.py"])


def test_git_selection_includes_staged_unstaged_untracked_and_deleted(tmp_path):
    def git(*arguments):
        return subprocess.run(["git", *arguments], cwd=tmp_path, check=True, capture_output=True)

    git("init", "-q")
    for name in ("staged.py", "unstaged.py", "deleted.py"):
        (tmp_path / name).write_text("before\n", encoding="utf-8")
    git("add", ".")
    git("-c", "user.name=CAE test", "-c", "user.email=cae-test@example.invalid", "commit", "-qm", "baseline")
    (tmp_path / "staged.py").write_text("staged\n", encoding="utf-8")
    git("add", "staged.py")
    (tmp_path / "unstaged.py").write_text("unstaged\n", encoding="utf-8")
    (tmp_path / "new.py").write_text("new\n", encoding="utf-8")
    (tmp_path / "deleted.py").unlink()
    assert changed_paths(tmp_path, "HEAD") == ["deleted.py", "new.py", "staged.py", "unstaged.py"]


@pytest.mark.parametrize("changed,expected", [
    (["docs/development/particles.md"], 0),
    ([CAE_PREFIX + "app/unknown/new.py"], 2),
])
def test_runner_lists_docs_without_cpu_execution_and_rejects_unknown_sources(tmp_path, changed, expected):
    report = tmp_path / "selection"
    script = ("from unittest.mock import patch\nfrom tests.run import main\n"
              f"with patch('tests.run.changed_paths', return_value={changed!r}):\n"
              f"    raise SystemExit(main(['affected', '--list', '--report', {str(report)!r}]))\n")
    result = subprocess.run([sys.executable, "-c", script], cwd=CAE, capture_output=True, text=True, encoding="utf-8")
    assert result.returncode == expected, result.stdout + result.stderr
    if expected == 0:
        summary = json.loads((report / "summary.json").read_text())
        assert summary["selected"] == 0 and summary["runExitStatus"] == 0
        assert json.loads((report / "invocation.json").read_text())["actions"] == ["docs"]
        assert '"event": "started"' not in (report / "events.jsonl").read_text()
    else:
        assert "No CAE test ownership" in result.stderr
        assert not report.exists()


def test_progress_report_retains_interrupted_test_without_claiming_a_pass(tmp_path, monkeypatch):
    from tests import cli_build_observer

    build_events = tmp_path / "cli-build-events"
    monkeypatch.setenv("CAEMBLE_CLI_BUILD_EVENTS_DIR", str(build_events))
    cli_build_observer.install()

    def fake_cli(arguments, **kwargs):
        code = 0 if arguments[-1] == "success" else 2
        if kwargs.get("check") and code:
            raise subprocess.CalledProcessError(code, arguments)
        return subprocess.CompletedProcess(arguments, code)

    monkeypatch.setattr(cli_build_observer, "_original_run", fake_cli)
    command = ["node", "caemble.cjs", "experiment", "build"]
    subprocess.run([*command, "success"])
    subprocess.run([*command, "invalid-input"])
    with pytest.raises(subprocess.CalledProcessError):
        subprocess.run([*command, "invalid-input"], check=True)
    subprocess.run(["node", "caemble.cjs", "calculation", "run", "success"])
    (build_events / "unfinished.jsonl").write_text(
        '{"event":"started","attempt":"interrupted"}\n', encoding="utf-8")
    shared = tmp_path / "builds" / "shared"
    shared.mkdir(parents=True)
    (shared / "complete.json").write_text('{"duration":0.1}', encoding="utf-8")
    report = ProgressReport(tmp_path, "quick")
    report.collect({"a": "selected", "b": "selected"})
    report.active["b"] = "started"
    report.results = {"a": {"outcome": "passed", "phases": {"setup": .1, "call": 1., "teardown": .2}},
                      "b": {"outcome": "passed", "phases": {"setup": .1}}}
    report.event("started", nodeid="b")
    assert json.loads((tmp_path / "status.json").read_text())["active"] == {"b": "started"}
    report.finish(2, False)
    summary = json.loads((tmp_path / "summary.json").read_text())
    assert summary["outcomes"]["passed"] == 1
    assert summary["unfinished"] == {"b": "started"} and summary["exitStatus"] == 2
    assert summary["sharedInputBuildCount"] == summary["buildCount"] == 1
    assert summary["cliBuilds"]["attempts"] == 4
    assert summary["cliBuilds"]["succeeded"] == 1 and summary["cliBuilds"]["failed"] == 2
    assert len(summary["cliBuilds"]["unfinished"]) == 1
