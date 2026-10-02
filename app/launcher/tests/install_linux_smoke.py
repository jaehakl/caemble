"""Dependency-free Linux smoke: real Bash/installer/locks, fake package installation commands."""
from __future__ import annotations

import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("launcher_journal", SOURCE / "app/launcher/app/journal.py")
journal_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal_module)

FAKE_COMMAND = r'''
import fcntl, json, os, pathlib, sys
command, *args = sys.argv[1:]
real_python = os.environ['SMOKE_PYTHON']
if command == 'python' and ('-c' in args and '-I' not in args or 'install.py' in ' '.join(args)):
    os.execv(real_python, [real_python, *args])
with open(os.environ['SMOKE_LOCK'], 'a+b') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        pass
    else:
        raise SystemExit('Installer released runtime.lock during a child command')
with open(os.environ['SMOKE_LOG'], 'a', encoding='utf-8') as log:
    log.write(json.dumps({'command': command, 'args': args, 'project': pathlib.Path.cwd().name}) + '\n')
if command == 'node':
    print('v24.14.0')
elif command == 'poetry':
    if args == ['--version']:
        print('Poetry (version 2.2.1)')
    if args[:1] == ['install'] and pathlib.Path.cwd().name == os.environ.get('SMOKE_FAIL_PROJECT'):
        raise SystemExit(17)
elif args[:2] == ['-I', '-c']:
    print(json.dumps([3, 12, 14]))
elif args == ['-m', 'venv', '.venv']:
    python = pathlib.Path('.venv/bin/python')
    python.parent.mkdir(parents=True)
    python.write_text(pathlib.Path(os.environ['SMOKE_PYTHON_WRAPPER']).read_text(), encoding='utf-8')
    python.chmod(0o755)
elif args[-3:] in (['-m', 'app', 'prepare'], ['-m', 'app', 'doctor']):
    print(json.dumps({'ready': True}))
else:
    raise SystemExit('Unexpected fake command: ' + repr(args))
'''


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux/WSL only")
class LinuxInstallerSmoke(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="launcher install smoke ")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.repo = self.directory / "checkout with spaces"
        self.bin = self.directory / "command fakes"
        self.bin.mkdir()
        self.projects = ["app/launcher", *(f"app/slaves/{name}" for name in (
            "ai", "tts_kokoro", "tts_voicevox", "cae_simulation", "cae_evaluation", "cae_prediction"))]
        for relative in self.projects:
            project = self.repo / relative
            project.mkdir(parents=True)
            (project / "pyproject.toml").write_text(
                f'[project]\nname = "{project.name}"\nrequires-python = ">=3.11,<3.15"\n', encoding="utf-8")
            (project / "poetry.lock").write_text("# fixture\n", encoding="utf-8")
        shutil.copyfile(SOURCE / "li_launcher_install.sh", self.repo / "li_launcher_install.sh")
        shutil.copyfile(SOURCE / "app/launcher/install.py", self.repo / "app/launcher/install.py")
        self.state = self.repo / "app/launcher/relative state"
        (self.repo / "app/launcher/.env").write_text(
            "CAEMBLE_LAUNCHER_STATE_DIR='relative state'\nPRIVATE_TOKEN=not-printed\n", encoding="utf-8")
        legacy = self.repo / "app/slaves/evaluation"
        legacy.mkdir()
        (legacy / ".env").write_text("PRIVATE_TOKEN=preserved\n", encoding="utf-8")
        (legacy / "runtime.toml").write_text(f"node = {json.dumps(str(self.bin / 'node'))}\n", encoding="utf-8")
        legacy_python = self.repo / "app/slaves/cae/.venv/bin/python"
        legacy_python.parent.mkdir(parents=True)
        legacy_python.write_text("legacy environment stays here", encoding="utf-8")
        deployment = self.repo / "deployment"
        deployment.mkdir()
        with tarfile.open(deployment / "caemble.tar.gz", "w:gz") as archive:
            for name in ("caemble.cjs", "worker.cjs", "caemble-core.d.ts", "cad-jsx.d.ts", "lib.es5.d.ts", "build-info.json"):
                data = b'{"version":"1","inputs":{}}' if name == "build-info.json" else b"fixture"
                entry = tarfile.TarInfo(f"node/{name}")
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
        fake = self.bin / "commands.py"
        fake.write_text(FAKE_COMMAND, encoding="utf-8")
        for command in ("poetry", "node", "python3.12", "python3", "python"):
            wrapper = self.bin / command
            kind = "python" if command.startswith("python") else command
            wrapper.write_text(
                f"#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(fake))} {kind} \"$@\"\n", encoding="utf-8")
            wrapper.chmod(0o755)
        self.log = self.directory / "commands.jsonl"
        self.environment = {key: value for key, value in os.environ.items()
            if key.lower() not in {"caemble_launcher_state_dir", "state_dir"}}
        self.environment.update(PATH=f"{self.bin}:/usr/bin:/bin", SMOKE_PYTHON=sys.executable,
            SMOKE_LOCK=str(self.state / "runtime.lock"), SMOKE_LOG=str(self.log),
            SMOKE_PYTHON_WRAPPER=str(self.bin / "python3.12"))

    def run_installer(self, **overrides):
        return subprocess.run(["/bin/bash", str(self.repo / "li_launcher_install.sh")], cwd="/tmp",
            env={**self.environment, **overrides}, capture_output=True, text=True, timeout=30)

    def test_full_install_from_unrelated_cwd_with_spaces(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]
        installs = [call for call in calls if call["args"][:1] == ["install"]]
        self.assertEqual([call["project"] for call in installs], [Path(path).name for path in self.projects])
        self.assertTrue(all(call["args"] == ["install", "--only", "main", "--no-interaction"] for call in installs))
        self.assertEqual(calls[-2]["args"][-1], "prepare")
        self.assertEqual(calls[-1]["args"][-1], "doctor")
        self.assertNotIn("not-printed", result.stdout + result.stderr)
        self.assertEqual((self.repo / "app/slaves/cae/.venv/bin/python").read_text(), "legacy environment stays here")

    def test_failed_install_retries_without_losing_configuration(self):
        failed = self.run_installer(SMOKE_FAIL_PROJECT="cae_simulation")
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("[cae_simulation] install dependencies", failed.stderr)
        copied = self.repo / "app/slaves/cae_evaluation/.env"
        self.assertEqual(copied.read_bytes(), (self.repo / "app/slaves/evaluation/.env").read_bytes())
        retried = self.run_installer()
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertEqual(copied.read_text(), "PRIVATE_TOKEN=preserved\n")

    def test_running_launcher_refuses_before_commands(self):
        journal = journal_module.LauncherJournal(self.state)
        try:
            result = self.run_installer()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Launcher or another installer is running", result.stderr)
            self.assertFalse(self.log.exists())
        finally:
            journal.close()

    def test_startup_python_prerequisite_failure(self):
        for name in ("python3.12", "python3", "python"):
            (self.bin / name).write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Python 3.11+", result.stderr)
        self.assertFalse(self.log.exists())

    def test_populate_by_name_state_environment_uses_launcher_lock(self):
        (self.repo / "app/launcher/.env").write_text("PRIVATE_TOKEN=not-printed\n", encoding="utf-8")
        state = self.repo / "app/launcher/field name state"
        journal = journal_module.LauncherJournal(state)
        try:
            result = self.run_installer(STATE_DIR="field name state")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Launcher or another installer is running", result.stderr)
            self.assertFalse(self.log.exists())
        finally:
            journal.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
