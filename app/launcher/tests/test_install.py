from __future__ import annotations

import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile

import pytest

import install as installer
from app.journal import LauncherJournal
from app.settings import APP_ROOT, LauncherSettings


@pytest.fixture
def checkout(tmp_path, monkeypatch):
    repo = tmp_path / "checkout with spaces"
    for relative in installer.PROJECTS:
        directory = repo / relative
        directory.mkdir(parents=True)
        requirement = ">=3.12,<3.13" if directory.name == "tts_kokoro" else ">=3.11,<3.15"
        (directory / "pyproject.toml").write_text(
            f'[project]\nname = "{directory.name}"\nrequires-python = "{requirement}"\n', encoding="utf-8")
        (directory / "poetry.lock").write_text("# fixture locked dependencies\n", encoding="utf-8")
    deployment = repo / "deployment"
    deployment.mkdir()
    with tarfile.open(deployment / "caemble.tar.gz", "w:gz") as archive:
        for name in installer.NODE_ASSETS:
            data = b'{"version":"1","inputs":{}}' if name == "build-info.json" else b"runtime fixture"
            entry = tarfile.TarInfo(f"node/{name}")
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    calls = []
    control = {"node": "v24.14.0", "versions": {}, "fail": None, "missing": set()}

    def which(command, path=None):
        if command in control["missing"]:
            return None
        if command in {"poetry", "node", "python3.12", "python3", "python", sys.executable} or os.path.isabs(command):
            return command
        return None

    def run(arguments, **options):
        calls.append((arguments, options))
        if control["fail"] and control["fail"](arguments, options):
            raise subprocess.CalledProcessError(7, arguments, stderr="fixture failure")
        if arguments[-1] == "--version":
            output = "Poetry (version 2.2.1)" if arguments[0] == "poetry" else control["node"]
        elif "-c" in arguments:
            output = json.dumps(control["versions"].get(arguments[0], [3, 12, 4]))
        else:
            output = ""
        if arguments[-3:] == ["-m", "venv", ".venv"]:
            python = Path(options["cwd"]) / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            python.parent.mkdir(parents=True)
            python.write_bytes(b"fixture interpreter")
        return subprocess.CompletedProcess(arguments, 0, stdout=output, stderr="")

    monkeypatch.setattr(installer.shutil, "which", which)
    monkeypatch.setattr(installer.subprocess, "run", run)
    monkeypatch.delenv("CAEMBLE_LAUNCHER_STATE_DIR", raising=False)
    monkeypatch.delenv("STATE_DIR", raising=False)
    return repo, calls, control


def test_all_projects_once_from_any_directory_and_spaces(checkout, monkeypatch, tmp_path):
    repo, calls, _ = checkout
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("VIRTUAL_ENV", "unrelated environment")
    monkeypatch.setenv("CONDA_PREFIX", "unrelated conda")
    monkeypatch.setattr(installer, "PROJECTS", (*installer.PROJECTS, "app/slaves/cae_prediction"))
    installer.install(repo)
    installs = [(args, options) for args, options in calls if args[1:2] == ["install"]]
    assert len(installs) == 7
    assert [options["cwd"].name for _, options in installs] == [
        "launcher", "ai", "tts_kokoro", "tts_voicevox", "cae_simulation", "cae_evaluation", "cae_prediction"]
    for args, options in installs:
        assert args == ["poetry", "install", "--only", "main", "--no-interaction"]
        assert options["env"]["POETRY_VIRTUALENVS_IN_PROJECT"] == "true"
        assert "VIRTUAL_ENV" not in options["env"] and "CONDA_PREFIX" not in options["env"]
    assert calls[-2][0][-4:] == ["utf8", "-m", "app", "prepare"]
    assert calls[-1][0][-4:] == ["utf8", "-m", "app", "doctor"]
    assert all("--sync" not in args and "update" not in args and "lock" not in args for args, _ in calls)


def test_reuses_compatible_environment_and_preserves_legacy_environment(checkout):
    repo, calls, control = checkout
    local_python = repo / "app/slaves/cae_simulation/.venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    local_python.parent.mkdir(parents=True)
    local_python.write_bytes(b"installed interpreter")
    control["versions"][str(local_python)] = [3, 11, 9]
    legacy_python = repo / "app/slaves/cae/.venv/bin/python"
    legacy_python.parent.mkdir(parents=True)
    legacy_python.write_bytes(b"legacy interpreter")
    installer.install(repo)
    created = [options["cwd"].name for args, options in calls if args[-3:] == ["-m", "venv", ".venv"]]
    assert "cae_simulation" not in created and len(created) == 6
    assert local_python.read_bytes() == b"installed interpreter"
    assert legacy_python.read_bytes() == b"legacy interpreter"


@pytest.mark.parametrize("missing", ["poetry", "node", "python3.12"])
def test_missing_prerequisite_fails_before_install(checkout, missing):
    repo, calls, control = checkout
    control["missing"].add(missing)
    if missing == "python3.12":
        control["missing"].update({sys.executable, "python3", "python"})
    with pytest.raises(installer.InstallError, match="prerequisite"):
        installer.install(repo)
    assert not any(args[1:2] == ["install"] or "venv" in args for args, _ in calls)


@pytest.mark.parametrize("filename", ["poetry.lock", "pyproject.toml"])
def test_missing_project_file_fails_before_any_install(checkout, filename):
    repo, calls, _ = checkout
    (repo / "app/slaves/cae_prediction" / filename).unlink()
    with pytest.raises(installer.InstallError, match=f"cae_prediction.*Missing {filename}"):
        installer.install(repo)
    assert not any(args[1:2] == ["install"] or "venv" in args for args, _ in calls)


def test_old_node_and_invalid_release_fail_before_install(checkout):
    repo, calls, control = checkout
    control["node"] = "v24.13.9"
    with pytest.raises(installer.InstallError, match="Node 24.14"):
        installer.install(repo)
    control["node"] = "v24.14.0"
    (repo / "deployment/caemble.tar.gz").write_bytes(b"invalid archive")
    with pytest.raises(installer.InstallError, match="release prerequisite"):
        installer.install(repo)
    assert not any(args[1:2] == ["install"] for args, _ in calls)


def test_incompatible_environment_is_preserved(checkout):
    repo, calls, control = checkout
    python = repo / "app/slaves/tts_kokoro/.venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    python.parent.mkdir(parents=True)
    python.write_bytes(b"keep incompatible interpreter")
    control["versions"][str(python)] = [3, 11, 9]
    with pytest.raises(installer.InstallError, match="tts_kokoro.*preserved"):
        installer.install(repo)
    assert python.read_bytes() == b"keep incompatible interpreter"
    assert not any(args[1:2] == ["install"] for args, _ in calls)


def test_configuration_migration_preserves_originals_and_checks_collisions(checkout):
    repo, calls, control = checkout
    legacy = repo / "app/slaves/evaluation"
    legacy.mkdir()
    old = legacy / "runtime.toml"
    old.write_text('node = "./node with spaces"\n', encoding="utf-8")
    env = legacy / ".env"
    env.write_text("PRIVATE_VALUE=do-not-print\n", encoding="utf-8")
    installer.install(repo)
    destination = repo / "app/slaves/cae_evaluation"
    assert (destination / "runtime.toml").read_bytes() == old.read_bytes()
    assert (destination / ".env").read_bytes() == env.read_bytes()
    assert any(args[0] == str(destination / "node with spaces") for args, _ in calls)
    assert old.is_file() and env.is_file()
    installer.install(repo)  # Identical copies are accepted on rerun.
    (destination / ".env").write_text("PRIVATE_VALUE=changed\n", encoding="utf-8")
    calls.clear()
    with pytest.raises(installer.InstallError, match="configuration migration"):
        installer.install(repo)
    assert (destination / ".env").read_text(encoding="utf-8") == "PRIVATE_VALUE=changed\n"
    assert not any(args[1:2] == ["install"] for args, _ in calls)


def test_stale_lock_is_accepted_but_live_launcher_blocks_all_changes(checkout):
    repo, calls, _ = checkout
    state = repo / "app/launcher/.data/launcher"
    state.mkdir(parents=True)
    (state / "runtime.lock").write_bytes(b"old lock content")
    installer.install(repo)
    calls.clear()
    launcher = LauncherJournal(state)
    try:
        with pytest.raises(installer.InstallError, match="Launcher or another installer is running"):
            installer.install(repo)
        assert calls == []
    finally:
        launcher.close()


def test_lock_is_held_through_install_and_runtime_preparation(checkout, monkeypatch):
    repo, calls, _ = checkout
    state = repo / "app/launcher/.data/launcher"
    original = installer.run_command

    def verify_lock(*args, **kwargs):
        with pytest.raises(installer.InstallError, match="running"):
            with installer.installation_lock(state):
                pytest.fail("Concurrent lock should be refused")
        return original(*args, **kwargs)

    monkeypatch.setattr(installer, "run_command", verify_lock)
    installer.install(repo)
    assert calls[-1][0][-1] == "doctor"
    with installer.installation_lock(state):
        assert state.is_dir()


def test_failure_reports_project_and_step_and_can_be_retried(checkout):
    repo, calls, control = checkout
    control["fail"] = lambda args, options: args[1:2] == ["install"] and options["cwd"].name == "ai"
    with pytest.raises(installer.InstallError, match=r"\[ai\] install dependencies.*status 7"):
        installer.install(repo)
    assert not any(args[-1] == "prepare" for args, _ in calls)
    control["fail"] = None
    calls.clear()
    installer.install(repo)
    assert calls[-1][0][-1] == "doctor"
    created = [options["cwd"].name for args, options in calls if args[-3:] == ["-m", "venv", ".venv"]]
    assert "launcher" not in created and "ai" not in created


def test_dotenv_state_path_is_data_and_environment_wins(checkout, tmp_path):
    repo, _, _ = checkout
    (repo / "app/launcher/.env").write_text(
        "PRIVATE_TOKEN=hidden\nROOT='state folder'\nexport CAEMBLE_LAUNCHER_STATE_DIR=\"${ROOT}/custom\" # comment\n",
        encoding="utf-8")
    assert installer.launcher_state_directory(repo, {}) == (repo / "app/launcher/state folder/custom").resolve()
    target = str(tmp_path / "override state")
    assert installer.launcher_state_directory(repo, {"caemble_launcher_state_dir": target}) == Path(target).resolve()
    (repo / "app/launcher/.env").write_text("CAEMBLE_LAUNCHER_STATE_DIR='$(touch not-executed)'\n", encoding="utf-8")
    assert installer.launcher_state_directory(repo, {}).name == "$(touch not-executed)"
    assert not (repo / "not-executed").exists()


def test_relative_launcher_state_path_matches_installer_base(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    settings = LauncherSettings(_env_file=None, api_url="http://localhost:8000", access_token="fixture",
        state_dir=Path("relative state"))
    assert settings.state_dir == (APP_ROOT / "relative state").resolve()


def test_relative_configured_state_blocks_actual_launcher(checkout, monkeypatch, tmp_path):
    repo, calls, _ = checkout
    from app import settings as settings_module
    monkeypatch.setattr(settings_module, "APP_ROOT", repo / "app/launcher")
    monkeypatch.setenv("CAEMBLE_LAUNCHER_STATE_DIR", "state with spaces")
    monkeypatch.chdir(tmp_path)
    settings = LauncherSettings(_env_file=None, api_url="http://localhost:8000", access_token="fixture")
    assert settings.state_dir == installer.launcher_state_directory(repo, dict(os.environ))
    journal = LauncherJournal(settings.state_dir)
    try:
        with pytest.raises(installer.InstallError, match="runtime lock"):
            installer.install(repo)
        assert calls == []
    finally:
        journal.close()


@pytest.mark.parametrize("environment,dotenv,expected", [
    ({"STATE_DIR": "environment field"}, {}, "environment field"),
    ({"state_dir": "lowercase field"}, {}, "lowercase field"),
    ({"STATE_DIR": "environment field", "CAEMBLE_LAUNCHER_STATE_DIR": "environment alias"}, {}, "environment alias"),
    ({"STATE_DIR": "environment field"}, {"CAEMBLE_LAUNCHER_STATE_DIR": "dotenv alias"}, "dotenv alias"),
    ({"CAEMBLE_LAUNCHER_STATE_DIR": "environment alias"}, {"STATE_DIR": "dotenv field"}, "environment alias"),
    ({}, {"STATE_DIR": "dotenv field"}, "dotenv field"),
    ({}, {"STATE_DIR": "dotenv field", "CAEMBLE_LAUNCHER_STATE_DIR": "dotenv alias"}, "dotenv alias"),
    ({"STATE_DIR": "environment field"}, {"STATE_DIR": "dotenv field"}, "environment field"),
    ({}, {"'CAEMBLE_LAUNCHER_STATE_DIR'": "quoted alias"}, "quoted alias"),
    ({}, {"STATE.ROOT": "custom-state", "CAEMBLE_LAUNCHER_STATE_DIR": "${STATE.ROOT}"}, "custom-state"),
])
def test_state_alias_precedence_matches_actual_launcher_lock(checkout, monkeypatch, environment, dotenv, expected):
    repo, calls, _ = checkout
    from app import settings as settings_module
    monkeypatch.setattr(settings_module, "APP_ROOT", repo / "app/launcher")
    for key, value in environment.items():
        monkeypatch.setenv(key, value)
    env_file = repo / "app/launcher/.env"
    env_file.write_text("".join(f"{key}='{value}'\n" for key, value in dotenv.items()), encoding="utf-8")
    settings = LauncherSettings(_env_file=env_file, api_url="http://localhost:8000", access_token="fixture")
    assert settings.state_dir.name == expected
    assert settings.state_dir == installer.launcher_state_directory(repo, dict(os.environ))
    journal = LauncherJournal(settings.state_dir)
    try:
        with pytest.raises(installer.InstallError, match="runtime lock"):
            installer.install(repo)
        assert calls == []
    finally:
        journal.close()


def test_check_lock_failure_does_not_modify_any_environment(checkout):
    repo, calls, control = checkout
    control["fail"] = lambda args, options: args[1:3] == ["check", "--lock"] and options["cwd"].name == "tts_kokoro"
    with pytest.raises(installer.InstallError, match=r"\[tts_kokoro\] lockfile prerequisite"):
        installer.install(repo)
    assert not any(args[1:2] == ["install"] or "venv" in args for args, _ in calls)


def test_runtime_doctor_failure_is_reported(checkout):
    repo, _, control = checkout
    control["fail"] = lambda args, options: args[-3:] == ["-m", "app", "doctor"]
    with pytest.raises(installer.InstallError, match=r"\[cae_evaluation\] Node runtime doctor"):
        installer.install(repo)


@pytest.mark.parametrize("relative,stage", [
    ("app/slaves/cae_evaluation/runtime.toml", "Node configuration prerequisite"),
    ("app/slaves/tts_kokoro/pyproject.toml", "project prerequisite"),
])
def test_malformed_configuration_reports_project_and_step(checkout, relative, stage):
    repo, calls, _ = checkout
    target = repo / relative
    target.write_text('invalid = "unterminated', encoding="utf-8")
    with pytest.raises(installer.InstallError, match=rf"\[{target.parent.name}\] {stage}"):
        installer.install(repo)
    assert not any(args[1:2] == ["install"] for args, _ in calls)


def test_configuration_copy_error_reports_step_and_preserves_both_paths(checkout, monkeypatch):
    repo, _, _ = checkout
    legacy = repo / "app/slaves/predictor/.env"
    legacy.parent.mkdir()
    legacy.write_text("PRIVATE_VALUE=unchanged\n", encoding="utf-8")

    def failed_link(source, destination):
        raise PermissionError("fixture denied")

    monkeypatch.setattr(installer.os, "link", failed_link)
    with pytest.raises(installer.InstallError, match=r"\[cae_prediction\] configuration migration"):
        installer.install(repo)
    assert legacy.read_text(encoding="utf-8") == "PRIVATE_VALUE=unchanged\n"
    assert not (repo / "app/slaves/cae_prediction/.env").exists()
    assert not list((repo / "app/slaves/cae_prediction").glob(".launcher-install-*"))
