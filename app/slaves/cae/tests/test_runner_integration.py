"""Explicit integration checks for real CLI builds and worker interruption."""

import json
import multiprocessing
from pathlib import Path
import subprocess
import sys

import pytest
from tests.catalog_build import CatalogBuilds

REPO = Path(__file__).resolve().parents[4]
CAE = REPO / "app/slaves/cae"

def build_in_process(root, queue):
    try:
        measurement = CatalogBuilds(Path(root), REPO)["layered-cutaways"]
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
        first = builds["layered-cutaways"]
        first["experiment"]["scene"]["roots"].clear()
        assert builds["layered-cutaways"]["experiment"]["scene"]["roots"]
        builds.cli_hash = "different-cli-bundle"
        assert builds["layered-cutaways"]["experiment"]["scene"]["roots"]
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
        builds["layered-cutaways"]
    assert not list(tmp_path.glob("*/complete.json"))
    assert builds["layered-cutaways"]["experiment"]["scene"]["roots"]
    assert len(set(attempted)) == 2


def test_interrupted_worker_cleans_real_solver_child_mmap_and_workspace(tmp_path):
    probe = tmp_path / "test_interruption.py"
    probe.write_text('''
import asyncio
import json
import multiprocessing
from pathlib import Path
import numpy as np
import pytest
pytestmark = pytest.mark.smoke
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
            await executor.execute("tests.executor_transport_fixtures:forced_exit",
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
    result = subprocess.run([sys.executable, "-m", "pytest", str(probe), "-n", "2", "--dist", "worksteal", "-q",
                             "-c", str(CAE / "pyproject.toml"), "-p", "tests.reporting", "--cae-suite=quick",
                             "--cae-tiers=smoke", f"--cae-report={report}"],
                            cwd=CAE, capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert result.returncode != 0, result.stdout + result.stderr
    assert json.loads((tmp_path / "cleanup.json").read_text()) == {
        "childrenClean": True, "buffersClean": True, "workspacesClean": True,
    }
    summary = json.loads((report / "summary.json").read_text())
    assert summary["exitStatus"] != 0 and summary["outcomes"]["passed"] == 0
    assert summary["unfinished"]

