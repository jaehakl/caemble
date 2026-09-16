"""Selection, real shared CLI builds and reporting without running the full suite."""

import json
import multiprocessing
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from tests.catalog_build import CatalogBuilds
from tests.reporting import ProgressReport
from tests.selection import CAE_PREFIX, changed_paths, select_changes, selected_item


REPO = Path(__file__).resolve().parents[4]
CAE = REPO / "app/slaves/cae"


def item(nodeid, *, validation=False, **parameters):
    return SimpleNamespace(nodeid=nodeid, originalname=nodeid.split("::")[-1].split("[")[0],
                           callspec=SimpleNamespace(params=parameters),
                           get_closest_marker=lambda name: True if name == "validation" and validation else None)


def test_sph_output_selects_particle_consumers_without_fem_convergence():
    selection = select_changes([CAE_PREFIX + "app/solvers/sph/outputs.py"])
    assert selected_item(item("tests/test_sph_outputs.py::test_pressure"), selection, {})
    assert selected_item(item("tests/test_particle_runtime.py::test_record[sph]", particle_measurement="sph-hydrostatic-column"), selection, {})
    assert not selected_item(item("tests/test_particle_runtime.py::test_record[mpm]", particle_measurement="mpm-affine-compression"), selection, {})
    assert not selected_item(item("tests/test_particle_mpm.py::test_gravity"), selection, {})
    assert not selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), selection, {})
    assert not selection.actions


def test_shared_constitutive_method_selects_fem_mpm_and_validation():
    selection = select_changes([CAE_PREFIX + "app/methods/continuum/hyperelastic.py"])
    assert selection.solvers == {"structural_mechanics", "mpm"}
    assert selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), selection, {})
    assert selected_item(item("tests/test_particle_mpm.py::test_gravity"), selection, {})


@pytest.mark.parametrize("path", ["finite_volume/tetrahedral.py", "coupling/tetrahedral.py"])
def test_tetrahedral_flow_methods_select_cfd_validation_without_unrelated_convergence(path):
    selection = select_changes([CAE_PREFIX + "app/methods/" + path, "app/catalog/caemble_catalog/catalog.sqlite3"])
    assert selection.solvers == {"incompressible_flow"} and selection.quick
    assert selected_item(item("tests/test_incompressible_physics.py::test_duct_convergence", validation=True), selection, {})
    assert not selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), selection, {})
    assert not selected_item(item("tests/test_pressure_acoustics.py::test_convergence", validation=True), selection, {})
    shared = select_changes([CAE_PREFIX + "app/methods/coupling/surface.py"])
    assert "structural_mechanics" in shared.solvers and shared.validation


def test_transient_flow_selects_its_convergence_and_outputs_keep_quick_scope():
    numerical = select_changes([CAE_PREFIX + "app/solvers/incompressible_flow/transient.py"])
    output = select_changes([CAE_PREFIX + "app/solvers/incompressible_flow/outputs.py"])
    convergence = item("tests/test_incompressible_transient_physics.py::test_time_convergence", validation=True)
    assert selected_item(convergence, numerical, {})
    assert not selected_item(convergence, output, {})
    assert selected_item(item("tests/test_incompressible_runtime.py::test_checkpoint"), output, {})


def test_kernel_change_covers_real_children_without_long_physics():
    selection = select_changes([CAE_PREFIX + "app/kernel/coordinator/contracts.py"])
    for filename in ("test_particle_field_handoff", "test_mmap_executor", "test_rigid_runtime", "test_acoustic_transient_lifecycle"):
        assert selected_item(item(f"tests/{filename}.py::test_case"), selection, {})
    assert not selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), selection, {})


def test_changed_test_does_not_enable_unrelated_validation():
    selection = select_changes([CAE_PREFIX + "app/methods/fields/box_grid.py", CAE_PREFIX + "tests/test_sph_outputs.py"])
    assert not selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), selection, {})
    direct = select_changes([CAE_PREFIX + "tests/test_mixed_benchmarks.py"])
    assert selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), direct, {})


def test_catalog_and_docs_have_explicit_external_checks():
    catalog = select_changes(["app/catalog/caemble_catalog/catalog.sqlite3"])
    assert catalog.quick and catalog.actions == {"catalog", "examples"}
    assert not selected_item(item("tests/test_mixed_benchmarks.py::test_bending", validation=True), catalog, {})
    docs = select_changes(["docs/development/particles.md"])
    assert docs.actions == {"docs"} and not docs.quick and not docs.patterns


def test_unknown_cae_code_fails_and_current_source_ownership_is_complete():
    with pytest.raises(ValueError, match="No CAE test ownership"):
        select_changes([CAE_PREFIX + "app/solvers/new_physics/entry.py"])
    paths = [path.relative_to(REPO).as_posix() for path in (CAE / "app").rglob("*.py")]
    assert set(select_changes(paths).reasons) == set(paths)


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


def build_in_process(root, queue):
    try:
        measurement = CatalogBuilds(Path(root), REPO)["shell-cutaways"]
        queue.put(("ok", len(measurement["experiment"]["scene"]["roots"])))
    except BaseException as error:
        queue.put(("error", repr(error)))


def test_concurrent_real_cli_build_happens_once_and_returns_isolated_inputs(tmp_path):
    context = multiprocessing.get_context("spawn")
    queue = context.Queue()
    workers = [context.Process(target=build_in_process, args=(str(tmp_path), queue)) for _ in range(3)]
    try:
        for worker in workers:
            worker.start()
        answers = [queue.get(timeout=90) for _ in workers]
        assert all(answer[0] == "ok" for answer in answers), answers
        assert len(set(answers)) == 1
        for worker in workers:
            worker.join(10)
            assert worker.exitcode == 0
        assert len(list(tmp_path.glob("*/complete.json"))) == 1
        builds = CatalogBuilds(tmp_path, REPO)
        first = builds["shell-cutaways"]
        first["experiment"]["scene"]["roots"].clear()
        assert builds["shell-cutaways"]["experiment"]["scene"]["roots"]
        builds.cli_hash = "different-cli-bundle"
        assert builds["shell-cutaways"]["experiment"]["scene"]["roots"]
        assert len(list(tmp_path.glob("*/complete.json"))) == 2
    finally:
        for worker in workers:
            if worker.is_alive():
                worker.terminate()
            if worker.pid is not None:
                worker.join(10)
        queue.close()
        queue.join_thread()


def test_failed_build_is_not_reused_and_retry_has_a_fresh_destination(tmp_path, monkeypatch):
    builds = CatalogBuilds(tmp_path, REPO)
    original = subprocess.run
    attempted = []

    def fail_first(arguments, **kwargs):
        attempted.append(arguments[arguments.index("--out") + 1])
        if len(attempted) == 1:
            Path(attempted[-1]).mkdir()
            return subprocess.CompletedProcess(arguments, 1, "partial", "intentional failure")
        return original(arguments, **kwargs)

    monkeypatch.setattr(subprocess, "run", fail_first)
    with pytest.raises(RuntimeError, match="intentional failure"):
        builds["shell-cutaways"]
    assert not list(tmp_path.glob("*/complete.json"))
    assert builds["shell-cutaways"]["experiment"]["scene"]["roots"]
    assert len(set(attempted)) == 2


def test_progress_report_retains_interrupted_test_without_claiming_a_pass(tmp_path):
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


def test_interrupted_worker_cleans_real_solver_child_mmap_and_workspace(tmp_path):
    probe = tmp_path / "test_interruption.py"
    probe.write_text('''
import asyncio
import json
import multiprocessing
from pathlib import Path
import numpy as np
import pytest
from app.kernel.execution import MmapPayloadCodec, SpawnSolverExecutor
from app.kernel.resources import BufferStore
from tests.solver_test_support import invocation

def test_stop(tmp_path):
    async def run():
        children = {child.pid for child in multiprocessing.active_children()}
        store = BufferStore(tmp_path / "buffers")
        executor = SpawnSolverExecutor(codec=MmapPayloadCodec(store, array_threshold=128), cancellation_grace=.05)
        workspaces = []
        async def progress(value):
            if value.get("stage") == "ready":
                workspaces.append(Path(value["workspace"]))
                pytest.exit("controlled worker interruption", returncode=2)
        try:
            await executor.execute("tests.test_executor_shutdown:forced_exit",
                                   invocation({"values": np.arange(4096)}), progress=progress)
        finally:
            await executor.wait_for_cleanup()
            result = {"childrenClean": children == {child.pid for child in multiprocessing.active_children()},
                      "buffersClean": not store.files(),
                      "workspacesClean": bool(workspaces) and all(not path.exists() for path in workspaces)}
            store.close()
            Path(__file__).with_name("cleanup.json").write_text(json.dumps(result))
    asyncio.run(run())
''', encoding="utf-8")
    report = tmp_path / "interrupted"
    result = subprocess.run([sys.executable, "-m", "tests.run", "quick", "--jobs", "2", "--tests", str(probe),
                             "--report", str(report)], cwd=CAE, capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert result.returncode != 0, result.stdout + result.stderr
    assert json.loads((tmp_path / "cleanup.json").read_text()) == {
        "childrenClean": True, "buffersClean": True, "workspacesClean": True,
    }
    summary = json.loads((report / "summary.json").read_text())
    assert summary["exitStatus"] != 0 and summary["outcomes"]["passed"] == 0
    assert summary["unfinished"]


def test_full_collection_matches_original_cpu_and_quick_omits_only_validation(tmp_path):
    original = subprocess.run([sys.executable, "-m", "pytest", "tests", "-m", "not cuda", "--collect-only", "-q"],
                              cwd=CAE, check=True, capture_output=True, text=True, encoding="utf-8")
    baseline = {line.strip() for line in original.stdout.splitlines() if line.startswith("tests/") and "::" in line}
    selections = {}
    for suite in ("full", "quick"):
        report = tmp_path / suite
        result = subprocess.run([sys.executable, "-m", "tests.run", suite, "--list", "--report", str(report)],
                                cwd=CAE, capture_output=True, text=True, encoding="utf-8")
        assert result.returncode == 0, result.stdout + result.stderr
        selections[suite] = set(json.loads((report / "selected.json").read_text()))
    assert selections["full"] == baseline
    excluded = selections["full"] - selections["quick"]
    validation = subprocess.run([sys.executable, "-m", "pytest", "tests", "-m", "not cuda and validation", "--collect-only", "-q"],
                                cwd=CAE, check=True, capture_output=True, text=True, encoding="utf-8")
    expected = {line.strip() for line in validation.stdout.splitlines() if line.startswith("tests/") and "::" in line}
    assert excluded == expected
