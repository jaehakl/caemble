import asyncio
import json
import os
import tomllib
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.control import handle_server_message, launcher_hello_payload, print_slave_environment_status
from app.settings import LauncherSettings
from app.slave_registry import SlaveApp, SlaveAppRegistry, load_registry
from app.subprocess_manager import ManagedWorker, WorkerManager, json_line, subprocess_env


def launcher_settings(**overrides) -> LauncherSettings:
    return LauncherSettings(
        api_url="http://127.0.0.1:8000",
        access_token="test-token",
        **overrides,
    )


def write_manifest(root, folder_name: str, slave_app_id: str, **extra) -> None:
    plugin_dir = root / folder_name
    plugin_dir.mkdir()
    (plugin_dir / "manifest.json").write_text(
        json.dumps(
            {
                "id": slave_app_id,
                "name": slave_app_id.title(),
                "module": "app",
                **extra,
            }
        ),
        encoding="utf-8",
    )


def test_load_registry_from_manifests(tmp_path):
    write_manifest(tmp_path, "ai", "ai")
    write_manifest(tmp_path, "render", "render", startup_timeout_seconds=300)

    registry = load_registry(tmp_path)

    assert registry.ids() == ["ai", "render"]
    assert registry.require("ai").module == "app"
    assert registry.require("ai").project_dir == tmp_path / "ai"
    assert registry.require("ai").startup_timeout_seconds is None
    assert registry.require("render").startup_timeout_seconds == 300


def test_registry_builds_slave_app_metadata(tmp_path):
    write_manifest(tmp_path, "ai", "ai", startup_timeout_seconds=300)
    write_manifest(tmp_path, "render", "render")

    registry = load_registry(tmp_path)

    assert registry.metadata() == {
        "slave_apps": {
            "ai": {
                "startup_timeout_seconds": 300,
            }
        }
    }


def test_launcher_hello_payload_only_advertises_executable_slave_apps(tmp_path):
    write_manifest(tmp_path, "ai", "ai", startup_timeout_seconds=300)
    write_manifest(tmp_path, "cae", "cae", startup_timeout_seconds=60)
    registry = load_registry(tmp_path)
    ai = registry.require("ai")
    ai.python_executable.parent.mkdir(parents=True)
    ai.python_executable.write_text("", encoding="utf-8")
    if os.name != "nt":
        ai.python_executable.chmod(0o755)

    payload = launcher_hello_payload(launcher_settings(), registry)

    assert payload["slave_app_ids"] == ["ai"]
    assert payload["metadata"] == {
        "slave_apps": {
            "ai": {
                "startup_timeout_seconds": 300,
            }
        }
    }


def test_registry_rejects_duplicate_ids(tmp_path):
    with pytest.raises(ValueError):
        SlaveAppRegistry(
            [
                SlaveApp(id="ai", name="AI", module="app", project_dir=tmp_path / "ai"),
                SlaveApp(id="ai", name="AI Again", module="app", project_dir=tmp_path / "ai-again"),
            ]
        )


def test_registry_builds_worker_subprocess_args(tmp_path):
    slave_app = SlaveApp(id="ai", name="AI", module="app", project_dir=tmp_path / "ai")
    registry = SlaveAppRegistry([slave_app])

    assert registry.worker_subprocess_args("ai") == [
        str(slave_app.python_executable),
        "-m",
        "app",
        "--worker",
    ]


def test_cae_uses_project_local_poetry_environment():
    config_path = Path(__file__).resolve().parents[2] / "slaves" / "cae" / "poetry.toml"

    config = tomllib.loads(config_path.read_text(encoding="utf-8"))

    assert config["virtualenvs"]["in-project"] is True


def test_print_slave_environment_status_reports_ready_and_missing(tmp_path, capsys):
    ready = SlaveApp(id="ai", name="AI", module="app", project_dir=tmp_path / "ai")
    missing = SlaveApp(id="cae", name="CAE", module="app", project_dir=tmp_path / "cae")
    ready.python_executable.parent.mkdir(parents=True)
    ready.python_executable.write_text("", encoding="utf-8")
    if os.name != "nt":
        ready.python_executable.chmod(0o755)

    print_slave_environment_status(SlaveAppRegistry([ready, missing]))

    output = capsys.readouterr().out
    assert f"[slave:ai] environment ready: {ready.python_executable}" in output
    assert f"[slave:cae] environment missing: {missing.python_executable}" in output
    assert missing.install_hint in output


def test_worker_manager_uses_slave_startup_timeout_when_larger(tmp_path):
    registry = SlaveAppRegistry(
        [
            SlaveApp(
                id="ai",
                name="AI",
                module="app",
                project_dir=tmp_path / "ai",
                startup_timeout_seconds=300,
            )
        ]
    )
    manager = WorkerManager(
        launcher_settings(worker_ready_timeout_seconds=10),
        async_noop,
        registry,
    )

    assert manager.ready_timeout_seconds_for("ai") == 300


def test_worker_manager_uses_global_timeout_without_slave_override(tmp_path):
    registry = SlaveAppRegistry([SlaveApp(id="ai", name="AI", module="app", project_dir=tmp_path / "ai")])
    manager = WorkerManager(
        launcher_settings(worker_ready_timeout_seconds=10),
        async_noop,
        registry,
    )

    assert manager.ready_timeout_seconds_for("ai") == 10


def test_subprocess_env_includes_rtc_ice_servers_json():
    settings = launcher_settings(
        rtc_ice_servers_json='[{"urls":"stun:stun.example.com:3478"}]',
        rtc_ice_gather_timeout_seconds="1.5",
        rtc_memory_cache_enabled="false",
    )

    env = subprocess_env(settings)
    assert env["GPSTATION_V1_RTC_ICE_SERVERS_JSON"] == settings.rtc_ice_servers_json
    assert env["GPSTATION_V1_RTC_ICE_GATHER_TIMEOUT_SECONDS"] == "1.5"
    assert env["GPSTATION_V1_RTC_MEMORY_CACHE_ENABLED"] == "false"
    assert env["PYTHONIOENCODING"] == "utf-8"
    assert env["PYTHONUTF8"] == "1"


def test_subprocess_env_does_not_forward_unlisted_secrets(monkeypatch):
    monkeypatch.setenv("UNRELATED_SECRET", "do-not-forward")
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "0,1")

    env = subprocess_env(launcher_settings())

    assert "UNRELATED_SECRET" not in env
    assert env["CUDA_VISIBLE_DEVICES"] == "0,1"


def test_json_line_encodes_non_ascii_as_utf8():
    data = json_line({"kind": "job.ready", "input": {"prompt": "한글 prompt"}})

    assert data.endswith(b"\n")
    assert "한글".encode("utf-8") in data
    assert json.loads(data.decode("utf-8"))["input"]["prompt"] == "한글 prompt"


def test_registry_rejects_unknown_worker_app(tmp_path):
    registry = SlaveAppRegistry([SlaveApp(id="ai", name="AI", module="app", project_dir=tmp_path / "ai")])

    with pytest.raises(KeyError):
        registry.worker_subprocess_args("missing")


@pytest.mark.asyncio
async def test_start_job_missing_executable_venv_sends_error(tmp_path, capsys):
    messages = []

    async def send_control(message):
        messages.append(message)

    project_dir = tmp_path / "ai"
    project_dir.mkdir()
    registry = SlaveAppRegistry([SlaveApp(id="ai", name="AI", module="app", project_dir=project_dir)])
    manager = WorkerManager(launcher_settings(), send_control, registry)

    await manager.start_job(
        job_id="job-1",
        handler_type="ai.llm",
        slave_app_id="ai",
        offer={"type": "offer", "sdp": "v=0\r\n"},
    )

    assert messages[0]["type"] == "job.error"
    assert messages[0]["job_id"] == "job-1"
    assert messages[0]["code"] == "worker_start_failed"
    assert str(project_dir) in messages[0]["detail"]
    assert "poetry install" in messages[0]["detail"]
    assert manager.current_job_id is None
    output = capsys.readouterr().out
    assert "[job-1] worker start failed: slave_app_id=ai" in output
    assert messages[0]["detail"] in output


@pytest.mark.asyncio
async def test_start_job_rejects_second_job_while_busy(tmp_path):
    messages = []

    async def send_control(message):
        messages.append(message)

    project_dir = tmp_path / "ai"
    project_dir.mkdir()
    registry = SlaveAppRegistry([SlaveApp(id="ai", name="AI", module="app", project_dir=project_dir)])
    manager = WorkerManager(launcher_settings(), send_control, registry)
    manager.current_job_id = "job-1"

    await manager.start_job(
        job_id="job-2",
        handler_type="ai.llm",
        slave_app_id="ai",
        offer={"type": "offer", "sdp": "v=0\r\n"},
    )

    assert messages == [
        {
            "type": "job.error",
            "job_id": "job-2",
            "code": "launcher_busy",
            "detail": "launcher is busy with job job-1",
        }
    ]


@pytest.mark.asyncio
async def test_start_job_rejects_unknown_slave_app():
    messages = []

    async def send_control(message):
        messages.append(message)

    manager = WorkerManager(launcher_settings(), send_control, SlaveAppRegistry([]))

    await manager.start_job(
        job_id="job-1",
        handler_type="ai.llm",
        slave_app_id="missing",
        offer={"type": "offer", "sdp": "v=0\r\n"},
    )

    assert messages[0]["type"] == "job.error"
    assert messages[0]["code"] == "unknown_slave_app"


@pytest.mark.asyncio
async def test_cancel_job_forwards_cancel_to_worker_without_reset():
    messages = []

    async def send_control(message):
        messages.append(message)

    stdout_task = asyncio.create_task(asyncio.sleep(60))
    stderr_task = asyncio.create_task(asyncio.sleep(60))
    process = FakeWorkerProcess()
    manager = WorkerManager(launcher_settings(), send_control, SlaveAppRegistry([]))
    manager.worker = ManagedWorker(
        slave_app_id="ai",
        process=process,
        ready_event=asyncio.Event(),
        stdout_task=stdout_task,
        stderr_task=stderr_task,
        ready=True,
    )
    manager.current_job_id = "job-1"

    try:
        await manager.cancel_job("job-1", "user cancel")
    finally:
        stdout_task.cancel()
        stderr_task.cancel()

    assert process.stdin.messages == [
        {
            "type": "job.cancel",
            "job_id": "job-1",
            "reason": "user cancel",
        }
    ]
    assert manager.worker is not None
    assert manager.current_job_id == "job-1"
    assert manager.worker_status == "cancelling"
    assert messages == []
    manager.cancel_cancel_escalation()


@pytest.mark.asyncio
async def test_cancel_job_escalates_to_worker_reset_after_two_seconds(monkeypatch):
    stdout_task = asyncio.create_task(asyncio.sleep(60))
    stderr_task = asyncio.create_task(asyncio.sleep(60))
    process = FakeWorkerProcess()
    manager = WorkerManager(launcher_settings(), async_noop, SlaveAppRegistry([]))
    manager.worker = ManagedWorker(
        slave_app_id="cae",
        process=process,
        ready_event=asyncio.Event(),
        stdout_task=stdout_task,
        stderr_task=stderr_task,
        ready=True,
    )
    manager.current_job_id = "job-1"
    resets = []

    async def fake_reset(reason, **kwargs):
        resets.append(reason)
        manager.current_job_id = None

    monkeypatch.setattr("app.subprocess_manager.CANCEL_RESET_GRACE_SECONDS", 0)
    monkeypatch.setattr(manager, "reset_worker", fake_reset)
    try:
        await manager.cancel_job("job-1", "user cancel")
        await asyncio.sleep(0)
        await asyncio.sleep(0)
    finally:
        manager.cancel_cancel_escalation()
        stdout_task.cancel()
        stderr_task.cancel()

    assert resets == ["job job-1 did not stop within 0s: user cancel"]


@pytest.mark.asyncio
async def test_terminal_worker_message_cancels_pending_cancel_escalation():
    messages = []

    async def send_control(message):
        messages.append(message)

    manager = WorkerManager(launcher_settings(), send_control, SlaveAppRegistry([]))
    manager.current_job_id = "job-1"
    manager.cancel_escalation_task = asyncio.create_task(asyncio.sleep(60))

    await manager.handle_worker_message({"type": "job.cancelled", "job_id": "job-1", "reason": "user"})

    assert manager.cancel_escalation_task is None
    assert manager.current_job_id is None
    assert messages == [{"type": "job.cancelled", "job_id": "job-1", "reason": "user"}]


@pytest.mark.asyncio
async def test_cae_cancel_waits_for_run_cleanup_before_reusing_worker():
    messages = []

    async def send_control(message):
        messages.append(message)

    stdout_task = asyncio.create_task(asyncio.sleep(60))
    stderr_task = asyncio.create_task(asyncio.sleep(60))
    manager = WorkerManager(launcher_settings(), send_control, SlaveAppRegistry([]))
    manager.worker = ManagedWorker(
        slave_app_id="cae",
        process=FakeWorkerProcess(),
        ready_event=asyncio.Event(),
        stdout_task=stdout_task,
        stderr_task=stderr_task,
        ready=True,
    )
    manager.current_job_id = "job-1"
    manager.worker_status = "cancelling"
    manager.cancel_escalation_task = asyncio.create_task(asyncio.sleep(60))

    try:
        await manager.handle_worker_message(
            {"type": "cae.run.cleaned", "job_id": "job-1", "run_id": "run-1"}
        )
        assert manager.current_job_id == "job-1"
        assert manager.cancel_cleanup_confirmed_job_id == "job-1"

        await manager.handle_worker_message(
            {"type": "job.cancelled", "job_id": "job-1", "reason": "user"}
        )
    finally:
        manager.cancel_cancel_escalation()
        stdout_task.cancel()
        stderr_task.cancel()

    assert messages == [{"type": "job.cancelled", "job_id": "job-1", "reason": "user"}]
    assert manager.current_job_id is None
    assert manager.worker_status == "idle"
    assert manager.cancel_cleanup_confirmed_job_id is None
    assert manager.cancel_terminal_forwarded_job_id is None


@pytest.mark.asyncio
async def test_cae_failed_start_cleanup_marker_allows_immediate_worker_reuse():
    messages = []

    async def send_control(message):
        messages.append(message)

    stdout_task = asyncio.create_task(asyncio.sleep(60))
    stderr_task = asyncio.create_task(asyncio.sleep(60))
    manager = WorkerManager(launcher_settings(), send_control, SlaveAppRegistry([]))
    manager.worker = ManagedWorker(
        slave_app_id="cae",
        process=FakeWorkerProcess(),
        ready_event=asyncio.Event(),
        stdout_task=stdout_task,
        stderr_task=stderr_task,
        ready=True,
    )
    manager.current_job_id = "job-1"
    manager.worker_status = "busy"

    try:
        await manager.handle_worker_message(
            {"type": "cae.run.cleaned", "job_id": "job-1", "run_id": None}
        )
        await manager.handle_worker_message({"type": "job.result", "job_id": "job-1"})
    finally:
        manager.cancel_cancel_escalation()
        stdout_task.cancel()
        stderr_task.cancel()

    assert messages == [{"type": "job.result", "job_id": "job-1"}]
    assert manager.current_job_id is None
    assert manager.worker_status == "idle"
    assert manager.cancel_escalation_task is None


@pytest.mark.asyncio
async def test_cae_terminal_before_kill_waits_for_cleanup_and_keeps_escalation_armed():
    messages = []

    async def send_control(message):
        messages.append(message)

    stdout_task = asyncio.create_task(asyncio.sleep(60))
    stderr_task = asyncio.create_task(asyncio.sleep(60))
    manager = WorkerManager(launcher_settings(), send_control, SlaveAppRegistry([]))
    manager.worker = ManagedWorker(
        slave_app_id="cae",
        process=FakeWorkerProcess(),
        ready_event=asyncio.Event(),
        stdout_task=stdout_task,
        stderr_task=stderr_task,
        ready=True,
    )
    manager.current_job_id = "job-1"
    manager.worker_status = "busy"

    try:
        await manager.handle_worker_message(
            {"type": "job.error", "job_id": "job-1", "code": "job_error", "detail": "peer closed"}
        )
        assert manager.current_job_id == "job-1"
        assert manager.worker_status == "cancelling"
        assert manager.cancel_escalation_task is not None
        assert manager.cancel_terminal_forwarded_job_id == "job-1"

        await manager.cancel_job("job-1", "user cancel")
        assert manager.cancel_terminal_forwarded_job_id == "job-1"
        assert manager.worker.process.stdin.messages == [
            {
                "type": "job.cancel",
                "job_id": "job-1",
                "reason": "user cancel",
            }
        ]

        await manager.handle_worker_message(
            {"type": "cae.run.cleaned", "job_id": "job-1", "run_id": "run-1"}
        )
    finally:
        manager.cancel_cancel_escalation()
        stdout_task.cancel()
        stderr_task.cancel()

    assert messages == [
        {"type": "job.error", "job_id": "job-1", "code": "job_error", "detail": "peer closed"}
    ]
    assert manager.current_job_id is None
    assert manager.worker_status == "idle"


@pytest.mark.asyncio
async def test_cae_cancel_without_cleanup_resets_worker_without_duplicate_terminal(monkeypatch):
    messages = []
    resets = []

    async def send_control(message):
        messages.append(message)

    async def fake_reset(reason, **kwargs):
        resets.append((reason, kwargs))

    stdout_task = asyncio.create_task(asyncio.sleep(60))
    stderr_task = asyncio.create_task(asyncio.sleep(60))
    manager = WorkerManager(launcher_settings(), send_control, SlaveAppRegistry([]))
    manager.worker = ManagedWorker(
        slave_app_id="cae",
        process=FakeWorkerProcess(),
        ready_event=asyncio.Event(),
        stdout_task=stdout_task,
        stderr_task=stderr_task,
        ready=True,
    )
    manager.current_job_id = "job-1"
    manager.worker_status = "cancelling"
    manager.cancel_terminal_forwarded_job_id = "job-1"
    monkeypatch.setattr("app.subprocess_manager.CANCEL_RESET_GRACE_SECONDS", 0)
    monkeypatch.setattr(manager, "reset_worker", fake_reset)

    try:
        await manager.escalate_cancel("job-1", "user cancel")
    finally:
        stdout_task.cancel()
        stderr_task.cancel()

    assert resets == [
        (
            "job job-1 did not stop within 0s: user cancel",
            {"cancel_current_job": False},
        )
    ]
    assert messages == []
    assert manager.current_job_id is None
    assert manager.worker_status == "idle"


@pytest.mark.asyncio
async def test_reset_without_loaded_worker_still_acknowledges_completion():
    messages = []

    async def send_control(message):
        messages.append(message)

    manager = WorkerManager(launcher_settings(), send_control, SlaveAppRegistry([]))

    await manager.reset_worker("user reset")

    assert messages == [{"type": "worker.reset.done"}]


@pytest.mark.asyncio
async def test_handle_server_message_dispatches_job_controls():
    manager = FakeManager()

    await handle_server_message(
        manager,
        {
            "type": "job.start",
            "job_id": "job-1",
            "handler_type": "ai.llm",
            "slave_app_id": "ai",
            "offer": {"type": "offer", "sdp": "v=0\r\n"},
        },
    )
    await handle_server_message(manager, {"type": "job.cancel", "job_id": "job-1", "reason": "user"})
    await handle_server_message(manager, {"type": "worker.reset", "reason": "reset"})

    assert manager.calls == [
        (
            "start_job",
            {
                "job_id": "job-1",
                "handler_type": "ai.llm",
                "slave_app_id": "ai",
                "offer": {"type": "offer", "sdp": "v=0\r\n"},
            },
        ),
        ("cancel_job", "job-1", "user"),
        ("reset_worker", "reset"),
    ]


@pytest.mark.asyncio
async def test_handle_server_message_rejects_unknown_fields():
    with pytest.raises(ValidationError):
        await handle_server_message(
            object(),
            {
                "type": "job.cancel",
                "job_id": "job-1",
                "reason": "user",
                "unexpected": True,
            },
        )


@pytest.mark.asyncio
async def test_read_worker_stderr_prints_locally_without_control_message(capsys):
    messages = []

    async def send_control(message):
        messages.append(message)

    manager = WorkerManager(launcher_settings(), send_control, SlaveAppRegistry([]))
    manager.current_job_id = "job-1"
    process = FakeWorkerProcess(stderr_lines=[b"loading model\n"])

    await manager.read_worker_stderr(process)

    captured = capsys.readouterr()
    assert "[job-1] loading model" in captured.out
    assert messages == []


@pytest.mark.asyncio
async def test_server_error_message_prints_detail(capsys):
    await handle_server_message(
        object(),
        {
            "type": "error",
            "detail": "protocol mismatch",
        },
    )

    captured = capsys.readouterr()
    assert "Server control error: protocol mismatch" in captured.out


async def async_noop(message):
    return None


class FakeManager:
    def __init__(self):
        self.calls = []

    async def start_job(self, **kwargs):
        self.calls.append(("start_job", kwargs))

    async def cancel_job(self, job_id, reason):
        self.calls.append(("cancel_job", job_id, reason))

    async def reset_worker(self, reason):
        self.calls.append(("reset_worker", reason))


class FakeWorkerStdin:
    def __init__(self):
        self.messages = []

    def write(self, data):
        self.messages.append(json.loads(data.decode("utf-8")))

    async def drain(self):
        return None


class FakeWorkerProcess:
    def __init__(self, stderr_lines=None):
        self.stdin = FakeWorkerStdin()
        self.stderr = FakeStream(stderr_lines or [])
        self.returncode = None


class FakeStream:
    def __init__(self, lines):
        self.lines = list(lines)

    async def readline(self):
        if not self.lines:
            return b""
        return self.lines.pop(0)
