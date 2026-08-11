from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI

from gpstation.service import lifecycle


@pytest.mark.asyncio
async def test_lifespan_runs_without_a_database_lock(monkeypatch):
    db = object()
    session = AsyncMock()
    session.__aenter__.return_value = db
    session.__aexit__.return_value = False
    session_factory = Mock(return_value=session)
    initialize_slave_registry = Mock()
    recover_after_server_restart = AsyncMock()
    start_dispatcher = AsyncMock()
    stop_dispatcher = AsyncMock()
    close_all_launchers = AsyncMock()
    connect = Mock(side_effect=AssertionError("lifespan must not open a lock connection"))
    dispose = AsyncMock()

    monkeypatch.setattr(lifecycle, "SessionLocal", session_factory)
    monkeypatch.setattr(lifecycle, "initialize_slave_registry", initialize_slave_registry)
    monkeypatch.setattr(
        lifecycle.JobService,
        "recover_after_server_restart",
        recover_after_server_restart,
    )
    monkeypatch.setattr(
        lifecycle,
        "job_orchestrator",
        SimpleNamespace(
            start_dispatcher=start_dispatcher,
            stop_dispatcher=stop_dispatcher,
        ),
    )
    monkeypatch.setattr(
        lifecycle,
        "runtime",
        SimpleNamespace(close_all_launchers=close_all_launchers),
    )
    monkeypatch.setattr(
        lifecycle,
        "engine",
        SimpleNamespace(connect=connect, dispose=dispose),
    )

    app = FastAPI()
    async with lifecycle.gpstation_lifespan(app):
        assert app.state.progress == 0
        initialize_slave_registry.assert_called_once_with()
        session_factory.assert_called_once_with()
        recover_after_server_restart.assert_awaited_once_with(db)
        start_dispatcher.assert_awaited_once_with()
        stop_dispatcher.assert_not_awaited()

    connect.assert_not_called()
    stop_dispatcher.assert_awaited_once_with()
    close_all_launchers.assert_awaited_once_with()
    dispose.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_lifespan_cleans_up_when_recovery_fails(monkeypatch):
    session = AsyncMock()
    session.__aenter__.return_value = object()
    session.__aexit__.return_value = False
    recover_after_server_restart = AsyncMock(side_effect=RuntimeError("recovery failed"))
    start_dispatcher = AsyncMock()
    stop_dispatcher = AsyncMock()
    close_all_launchers = AsyncMock()
    dispose = AsyncMock()

    monkeypatch.setattr(lifecycle, "SessionLocal", Mock(return_value=session))
    monkeypatch.setattr(lifecycle, "initialize_slave_registry", Mock())
    monkeypatch.setattr(
        lifecycle.JobService,
        "recover_after_server_restart",
        recover_after_server_restart,
    )
    monkeypatch.setattr(
        lifecycle,
        "job_orchestrator",
        SimpleNamespace(
            start_dispatcher=start_dispatcher,
            stop_dispatcher=stop_dispatcher,
        ),
    )
    monkeypatch.setattr(
        lifecycle,
        "runtime",
        SimpleNamespace(close_all_launchers=close_all_launchers),
    )
    monkeypatch.setattr(lifecycle, "engine", SimpleNamespace(dispose=dispose))

    with pytest.raises(RuntimeError, match="recovery failed"):
        async with lifecycle.gpstation_lifespan(FastAPI()):
            pytest.fail("lifespan yielded after recovery failed")

    start_dispatcher.assert_not_awaited()
    stop_dispatcher.assert_awaited_once_with()
    close_all_launchers.assert_awaited_once_with()
    dispose.assert_awaited_once_with()
