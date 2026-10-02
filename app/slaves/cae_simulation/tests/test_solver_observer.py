"""Exercise the observer with a synthetic entry, without running physical solvers."""

import asyncio
from importlib.util import module_from_spec, spec_from_loader
import sys

import pytest

from app.kernel.api import SolverImplementation, SolverResult
from tests.solver_observer import observe_implementation, summarize


@pytest.fixture
def observed_entry(tmp_path, monkeypatch):
    name = "app.solvers.observer_fixture.entry"
    module = module_from_spec(spec_from_loader(name, loader=None))
    monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setenv("CAEMBLE_SOLVER_EVENTS_DIR", str(tmp_path))

    async def run(invocation):
        await asyncio.sleep(0)
        if invocation == "fail":
            raise ValueError("controlled failure")
        return SolverResult()

    run.__module__ = name
    module.run = run
    implementation = SolverImplementation(abi_version=3, run=run)
    observe_implementation(implementation)
    module.implementation = implementation
    return module, tmp_path


def test_direct_entry_and_implementation_are_observed_once(observed_entry, monkeypatch):
    module, directory = observed_entry
    monkeypatch.setenv("CAEMBLE_TEST_TIER", "smoke")
    asyncio.run(module.run(None))
    asyncio.run(module.implementation(None))
    with pytest.raises(ValueError, match="controlled failure"):
        asyncio.run(module.implementation.run("fail"))
    result = summarize(directory)
    assert result["count"] == 3 and not result["unfinished"]
    assert [call["outcome"] for call in result["calls"]] == ["passed", "passed", "failed"]
    assert result["duration"] >= 0


def test_lowcost_guard_rejects_entry_before_calling_solver(observed_entry, monkeypatch):
    module, directory = observed_entry
    monkeypatch.setenv("CAEMBLE_TEST_TIER", "lowcost")
    with pytest.raises(AssertionError, match="lowcost checks must not invoke product Solver"):
        asyncio.run(module.run(None))
    result = summarize(directory)
    assert result["count"] == 0 and len(result["blocked"]) == 1


def test_partial_child_event_is_not_reported_as_finished(tmp_path):
    (tmp_path / "123.jsonl").write_text(
        '{"event":"started","invocation":"a","solver":"fixture"}\n{"event":', encoding="utf-8")
    result = summarize(tmp_path)
    assert result["count"] == 1 and len(result["unfinished"]) == 1 and result["duration"] == 0


def test_spawn_observer_counts_child_entry_without_parent_double_count(tmp_path, monkeypatch):
    from app.kernel.execution import SpawnSolverExecutor
    from tests.solver_observer import install
    from tests.solver_test_support import invocation

    monkeypatch.setenv("CAEMBLE_TEST_TIER", "smoke")
    monkeypatch.setenv("CAEMBLE_SOLVER_EVENTS_DIR", str(tmp_path))
    install()

    async def execute():
        executor = SpawnSolverExecutor()
        try:
            result = await executor.execute("tests.observer_fixtures:implementation", invocation({}))
            assert isinstance(result, SolverResult)
        finally:
            await executor.wait_for_cleanup()

    asyncio.run(execute())
    summary = summarize(tmp_path)
    assert summary["count"] == 1 and not summary["unfinished"]
    assert summary["calls"][0]["outcome"] == "passed"


def test_collection_guard_rejects_product_dispatch_before_spawning(tmp_path, monkeypatch):
    from app.kernel.execution import SpawnSolverExecutor
    from tests.solver_test_support import invocation

    monkeypatch.setenv("CAEMBLE_TEST_TIER", "collection")
    monkeypatch.setenv("CAEMBLE_SOLVER_EVENTS_DIR", str(tmp_path))
    with pytest.raises(AssertionError, match="collection checks must not invoke product Solver"):
        asyncio.run(SpawnSolverExecutor().execute("app.solvers.synthetic.entry:implementation", invocation({})))
    result = summarize(tmp_path)
    assert result["count"] == 0 and len(result["blocked"]) == 1
    assert result["blocked"][0]["boundary"] == "parent dispatch"
