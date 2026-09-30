import asyncio
import json
from pathlib import Path
import shutil
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app import control
from app.slave_registry import SlaveApp, SlaveAppRegistry, load_manifest
from test_worker_modes import make_manager, offer


@pytest.mark.asyncio
async def test_startup_prepares_after_recovery_once_before_advertisement_and_build_assignment(tmp_path, monkeypatch):
    repo = Path(__file__).resolve().parents[3]
    project = tmp_path / "checkout" / "app" / "slaves" / "evaluation"
    project.mkdir(parents=True)
    shutil.copytree(repo / "app/slaves/evaluation/app", project / "app", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copyfile(repo / "app/slaves/evaluation/manifest.json", project / "manifest.json")
    deployment = project.parents[2] / "deployment"
    deployment.mkdir()
    scripts = project.parents[2] / "app/ui/scripts"
    scripts.mkdir(parents=True)
    shutil.copyfile(repo / "app/ui/scripts/node_runtime.py", scripts / "node_runtime.py")
    shutil.copyfile(repo / "deployment/caemble.tar.gz", deployment / "caemble.tar.gz")
    monkeypatch.setattr(SlaveApp, "python_executable", property(lambda _: Path(sys.executable)))
    manager = make_manager(tmp_path)
    manager.registry = SlaveAppRegistry([load_manifest(project / "manifest.json")])
    events = []

    async def recover():
        assert not (project.parents[2] / ".data/node-runtime/current").exists()
        events.append("recovered")

    original_prepare = manager.registry.prepare

    def prepare():
        assert events == ["recovered"]
        original_prepare()
        events.append("prepared")

    manager.initialize = recover
    monkeypatch.setattr(manager.registry, "prepare", prepare)
    monkeypatch.setattr(control, "WorkerManager", lambda *a, **k: manager)
    monkeypatch.setattr(control, "LauncherJournal", lambda *a: None)
    monkeypatch.setattr(control, "BACKOFF_SECONDS", [0])
    starts = AsyncMock()
    monkeypatch.setattr(manager, "launch_worker", starts)

    async def connect(settings, current, connection, **kwargs):
        hello = control.launcher_hello_payload(settings, current.registry, current, "session")
        assert hello["slave_app_ids"] == ["evaluation"]
        assert hello["job_modes"]["evaluation"] == "websocket"
        assert hello["storage_versions"]["evaluation"] == 1
        events.append("connected")
        if events.count("connected") == 1:
            raise ConnectionError("fixture reconnect")
        pending = {**offer(manager, 1), "slave_app_id": "evaluation", "handler_type": "cae.evaluation.build"}
        await manager.reserve_job(pending)
        worker = manager.instances[pending["instance_id"]]
        await manager.start_job({**pending, "type": "job.start", "allocation": worker.allocation})
        await worker.start_task
        starts.assert_awaited_once()
        raise asyncio.CancelledError

    monkeypatch.setattr(control, "run_connection", connect)
    settings = SimpleNamespace(launcher_name="test", state_dir=tmp_path / "state", control_grace_seconds=30)
    with pytest.raises(asyncio.CancelledError):
        await control.run_slave_launcher(settings)
    assert events == ["recovered", "prepared", "connected", "connected"]
    assert not manager.instances


def test_failed_preparation_is_reported_and_cannot_advertise_an_old_ready_bundle(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(SlaveApp, "python_executable", property(lambda _: Path(sys.executable)))
    app = SlaveApp("evaluation", "Evaluation", "app", tmp_path,
        prepare_args=("-c", "print('Evaluation archive missing'); raise SystemExit(1)"),
        readiness_args=("-c", "raise SystemExit(0)"))
    registry = SlaveAppRegistry([app])
    registry.prepare()
    assert app.executable_ready
    assert registry.ready_ids() == []
    assert registry.ready_ids() == []
    log = capsys.readouterr().out
    assert log.count("Evaluation archive missing") == 1
    assert "[evaluation] Preparation failed" in log


def test_readiness_reports_node_error_without_repeating_it_on_every_probe(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(SlaveApp, "python_executable", property(lambda _: Path(sys.executable)))
    error = json.dumps({"ready": False, "error": "Node executable unavailable"})
    app = SlaveApp("evaluation", "Evaluation", "app", tmp_path,
        readiness_args=("-c", f"print({error!r}); raise SystemExit(1)"))
    registry = SlaveAppRegistry([app])
    assert registry.ready_ids() == []
    assert registry.ready_ids() == []
    assert capsys.readouterr().out.count("Node executable unavailable") == 1
