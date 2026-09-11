from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
import time

import pytest

from app.kernel.api import SolverImplementation, SolverInvocation, SolverResult
from app.kernel.execution.child import _invoke
from app.kernel.execution.executor import SpawnSolverExecutor
from app.kernel.execution.errors import RemoteSolverError, SolverProtocolError
from app.kernel.execution.messages import ChildMessage, ChildMessageKind, RemoteError
from app.kernel.transport.handlers import run_measurement


@pytest.mark.asyncio
async def test_child_passes_current_settings_unchanged_and_does_not_retry(monkeypatch):
    config = {"parameters": {"pmlCellSize": 2, "rayCount": 10000, "dt": 0.001},
              "outputs": [{"key": "field"}]}
    invocation = SolverInvocation(config=config, state={}, inputs={}, world={}, geometry=None,
                                  progress=None, descriptor={})
    expected = SolverResult()
    runner = AsyncMock(return_value=expected)
    module = SimpleNamespace(implementation=SolverImplementation(3, runner))
    monkeypatch.setattr("app.kernel.execution.child.importlib.import_module", lambda _: module)
    assert await _invoke("fixture:implementation", invocation, 3) is expected
    assert runner.await_args.args[0] is invocation
    assert runner.await_args.args[0].config is config
    runner.side_effect = ValueError("original error")
    with pytest.raises(ValueError, match="original error"):
        await _invoke("fixture:implementation", invocation, 3)
    assert runner.await_count == 2


@pytest.mark.asyncio
async def test_retired_brief_job_rejected_before_input_loading(monkeypatch):
    create_run = Mock()
    monkeypatch.setattr("app.kernel.transport.handlers.CaeRun", create_run)
    with pytest.raises(Exception, match="Brief execution is no longer supported"):
        await run_measurement({"execution_mode": "brief"}, [], SimpleNamespace())
    create_run.assert_not_called()


@pytest.mark.asyncio
async def test_terminal_error_preserved_when_child_exit_is_late(monkeypatch):
    executor = SpawnSolverExecutor()
    cleanup = AsyncMock(side_effect=SolverProtocolError("sent a terminal message but did not exit"))
    monkeypatch.setattr(executor, "_require_clean_exit", cleanup)
    remote = RemoteError("builtins", "ValueError", "detector has no cell", "original traceback")
    connection = SimpleNamespace(poll=lambda: True, recv=Mock(side_effect=[
        ChildMessage(ChildMessageKind.STARTED, 12), ChildMessage(ChildMessageKind.ERROR, remote),
    ]))
    with pytest.raises(RemoteSolverError) as caught:
        await executor._monitor("fixture:implementation", SimpleNamespace(is_alive=lambda: True), connection,
            None, None, None, SimpleNamespace(), 12, float("inf"), time.monotonic())
    assert caught.value.remote is remote
    assert "original traceback" in str(caught.value)
    assert "did not exit" in str(caught.value)
    cleanup.assert_awaited_once()
