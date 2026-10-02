"""Install this checkout's locked Launcher and worker dependencies without third-party imports."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib


PROJECTS = (
    "app/launcher", "app/slaves/ai", "app/slaves/tts", "app/slaves/cae_simulation",
    "app/slaves/cae_evaluation", "app/slaves/cae_prediction",
)
LEGACY_PROJECTS = {"cae": "cae_simulation", "evaluation": "cae_evaluation", "predictor": "cae_prediction"}
NODE_ASSETS = {"caemble.cjs", "worker.cjs", "caemble-core.d.ts", "cad-jsx.d.ts", "lib.es5.d.ts", "build-info.json"}


class InstallError(RuntimeError):
    def __init__(self, project: str, step: str, message: str):
        super().__init__(f"[{project}] {step}: {message}")
        self.project = project
        self.step = step


@dataclass(frozen=True)
class Project:
    directory: Path
    python: Path
    create_environment: bool


def launcher_state_directory(repo: Path, environment: dict[str, str]) -> Path:
    """Read dotenv assignments as data; never execute shell syntax or expose credentials."""
    launcher = repo / "app/launcher"
    values: dict[str, str] = {}
    dotenv = launcher / ".env"
    if dotenv.is_file():
        pattern = re.compile(
            r"^[^\S\r\n]*(?:export[^\S\r\n]+)?(?:'(?P<quoted>[^']+)'|(?P<bare>[^=#\s]+))[^\S\r\n]*=[^\S\r\n]*"
            r"(?P<value>'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|[^\r\n]*)", re.MULTILINE,
        )
        content = dotenv.read_text(encoding="utf-8")
        for match in pattern.finditer(content):
            key, value = match["quoted"] or match["bare"], match["value"]
            if value.startswith(("'", '"')):
                if len(value) < 2 or value[-1] != value[0]:
                    raise InstallError("launcher", "configuration prerequisite", "Unterminated quoted dotenv assignment.")
                suffix = content[match.end():].split("\n", 1)[0].strip()
                if suffix and not suffix.startswith("#"):
                    raise InstallError("launcher", "configuration prerequisite", "Unexpected text after a quoted dotenv assignment.")
                quote, value = value[0], value[1:-1]
                escapes = {"\\": "\\", quote: quote}
                if quote == '"':
                    escapes.update({"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v", "a": "\a"})
                value = re.sub(r"\\(.)", lambda part: escapes.get(part[1], part[0]), value)
            else:
                value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
            value = re.sub(
                r"\$\{([^}:]+)(?::-([^}]*))?\}",
                lambda part: values.get(part[1], environment.get(part[1], part[2] or "")), value,
            )
            values[key] = value
    combined = {key.lower(): value for key, value in values.items()}
    combined.update({key.lower(): value for key, value in environment.items()})
    # Pydantic's validation alias wins over its populate_by_name field, even across sources.
    setting = combined.get("caemble_launcher_state_dir", combined.get("state_dir"))
    directory = Path(setting) if setting is not None else launcher / ".data/launcher"
    return (directory if directory.is_absolute() else launcher / directory).resolve()


@contextmanager
def installation_lock(directory: Path):
    try:
        directory.mkdir(parents=True, exist_ok=True)
        lock_stream = (directory / "runtime.lock").open("a+b", buffering=0)
    except OSError as error:
        raise InstallError("launcher", "runtime lock", str(error)) from error
    with lock_stream as stream:
        try:
            if os.name == "nt":
                import msvcrt
                if stream.seek(0, os.SEEK_END) == 0:
                    stream.write(b"0")
                    stream.flush()
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise InstallError("launcher", "runtime lock", "Launcher or another installer is running; stop it before installing.") from error
        yield


def run_command(project: Path, step: str, arguments: list[str], environment: dict[str, str], *, capture: bool = False):
    try:
        result = subprocess.run(
            arguments, cwd=project, env=environment, check=True, text=True, encoding="utf-8",
            errors="replace", capture_output=capture,
            timeout=60 if capture else None,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return result.stdout.strip() if capture else ""
    except (OSError, subprocess.SubprocessError) as error:
        detail = f"command exited with status {error.returncode}" if isinstance(error, subprocess.CalledProcessError) else str(error)
        if isinstance(error, subprocess.CalledProcessError) and capture:
            detail += ": " + (error.stderr or error.stdout or "").strip()[-2000:]
        raise InstallError(project.name, step, detail) from error


def python_version(executable: Path, project: Path, environment: dict[str, str]) -> tuple[int, ...]:
    output = run_command(project, "Python prerequisite", [str(executable), "-I", "-c",
        "import json,sys; print(json.dumps(list(sys.version_info[:3])))"], environment, capture=True)
    try:
        version = json.loads(output)
        if not isinstance(version, list) or len(version) != 3 or not all(type(value) is int for value in version):
            raise ValueError("Invalid Python version response")
        return tuple(version)
    except (ValueError, TypeError) as error:
        raise InstallError(project.name, "Python prerequisite", "Interpreter returned an invalid version.") from error


def compatible_python(version: tuple[int, ...], requirement: str) -> bool:
    operators = {">=": lambda left, right: left >= right, "<": lambda left, right: left < right,
                 "<=": lambda left, right: left <= right, ">": lambda left, right: left > right,
                 "==": lambda left, right: left == right, "!=": lambda left, right: left != right}
    for clause in requirement.split(","):
        match = re.fullmatch(r"\s*(>=|<=|==|!=|>|<)\s*(\d+(?:\.\d+){1,2})\s*", clause)
        if match is None:
            raise ValueError(f"Unsupported requires-python constraint: {requirement}")
        required = tuple(int(value) for value in match[2].split("."))
        required += (0,) * (3 - len(required))
        if not operators[match[1]](version, required):
            return False
    return True


def configuration_copies(repo: Path) -> list[tuple[Path, Path]]:
    copies = []
    for old, new in LEGACY_PROJECTS.items():
        for name in (".env", "runtime.toml"):
            source, destination = repo / "app/slaves" / old / name, repo / "app/slaves" / new / name
            try:
                if not source.is_file():
                    continue
                if destination.exists() or destination.is_symlink():
                    if not destination.is_file() or source.read_bytes() != destination.read_bytes():
                        raise InstallError(new, "configuration migration", f"Both old and new {name} exist with different contents; reconcile them before retrying.")
                else:
                    copies.append((source, destination))
            except OSError as error:
                raise InstallError(new, "configuration migration", str(error)) from error
    return copies


def check_release(repo: Path) -> None:
    try:
        with tarfile.open(repo / "deployment/caemble.tar.gz", "r:gz") as archive:
            entries = {}
            for member in archive.getmembers():
                name = member.name.removeprefix("./")
                if not name.startswith("node/") or (member.isdir() and name.rstrip("/") == "node"):
                    continue
                name = name.removeprefix("node/")
                if not member.isfile() or name in {"", ".", ".."} or any(char in name for char in "/\\:"):
                    raise ValueError("Invalid Node runtime archive entry")
                if name in entries:
                    raise ValueError("Duplicate Node runtime archive entry")
                entries[name] = member
            if not NODE_ASSETS.issubset(entries):
                raise ValueError("Release archive is missing required Node runtime assets")
            with archive.extractfile(entries["build-info.json"]) as stream:
                if json.load(stream).get("version") != "1":
                    raise ValueError("Unsupported Node runtime metadata version")
    except (OSError, tarfile.TarError, ValueError, AttributeError) as error:
        raise InstallError("cae_evaluation", "release prerequisite", str(error)) from error


def preflight(repo: Path, environment: dict[str, str]) -> tuple[str, list[Project], list[tuple[Path, Path]]]:
    poetry = shutil.which("poetry", path=environment.get("PATH"))
    if poetry is None:
        raise InstallError("launcher", "Poetry prerequisite", "Poetry is not installed or is not on PATH.")
    run_command(repo, "Poetry prerequisite", [poetry, "--version"], environment, capture=True)
    copies = configuration_copies(repo)
    check_release(repo)
    evaluation = repo / "app/slaves/cae_evaluation"
    config_path = evaluation / "runtime.toml"
    if not config_path.exists():
        config_path = next((source for source, destination in copies if destination == config_path), config_path)
    try:
        config = tomllib.loads(config_path.read_text(encoding="utf-8")) if config_path.is_file() else {}
    except (OSError, ValueError) as error:
        raise InstallError("cae_evaluation", "Node configuration prerequisite", "Cannot read a valid runtime.toml.") from error
    node_setting = config.get("node", "node")
    if not isinstance(node_setting, str) or not node_setting:
        raise InstallError("cae_evaluation", "Node prerequisite", "runtime.toml node must be a nonempty executable path or name.")
    node_candidate = Path(node_setting)
    if not node_candidate.is_absolute() and os.path.dirname(node_setting):
        node_setting = str(evaluation / node_candidate)
    node = shutil.which(node_setting, path=environment.get("PATH"))
    if node is None:
        raise InstallError("cae_evaluation", "Node prerequisite", "Node 24.14+ is required; install it or configure runtime.toml node.")
    version = run_command(evaluation, "Node prerequisite", [node, "--version"], environment, capture=True)
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", version)
    if match is None or tuple(int(value) for value in match.groups()) < (24, 14, 0):
        raise InstallError("cae_evaluation", "Node prerequisite", "Node 24.14+ is required.")
    projects = []
    new_python = None
    seen = set()
    for relative in PROJECTS:
        directory = (repo / relative).resolve()
        if directory in seen:
            continue
        seen.add(directory)
        for filename in ("pyproject.toml", "poetry.lock"):
            if not (directory / filename).is_file():
                raise InstallError(directory.name, "project prerequisite", f"Missing {filename} in this checkout.")
        try:
            config = tomllib.loads((directory / "pyproject.toml").read_text(encoding="utf-8"))
            for dependency in config.get("tool", {}).get("poetry", {}).get("dependencies", {}).values():
                if isinstance(dependency, dict) and "path" in dependency:
                    if not (directory / dependency["path"] / "pyproject.toml").is_file():
                        raise InstallError(directory.name, "shared prerequisite", "A local shared dependency is missing from this checkout.")
            requirement = config["project"]["requires-python"]
            compatible_python((3, 12, 0), requirement)
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
            raise InstallError(directory.name, "project prerequisite", "Cannot read a valid pyproject.toml or requires-python constraint.") from error
        executable = directory / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        create = not (directory / ".venv").exists()
        if not create:
            if not executable.is_file() or not compatible_python(python_version(executable, directory, environment), requirement):
                raise InstallError(directory.name, "Python prerequisite", "Existing .venv is unavailable or incompatible; it has been preserved. Use a compatible environment before retrying.")
        else:
            if new_python is None:
                for candidate in ("python3.12", sys.executable, "python3", "python"):
                    found = shutil.which(candidate, path=environment.get("PATH"))
                    if found and python_version(Path(found), directory, environment)[:2] == (3, 12):
                        new_python = Path(found)
                        break
                if new_python is None:
                    raise InstallError(directory.name, "Python prerequisite", "Python 3.12 is required to create missing environments.")
            if not compatible_python(python_version(new_python, directory, environment), requirement):
                raise InstallError(directory.name, "Python prerequisite", "Python 3.12 does not satisfy this project's requirement.")
        run_command(directory, "lockfile prerequisite", [poetry, "check", "--lock"], environment, capture=True)
        projects.append(Project(directory, new_python if create else executable, create))
    return poetry, projects, copies


def install(repo: Path) -> None:
    environment = dict(os.environ)
    try:
        state_directory = launcher_state_directory(repo, environment)
    except (OSError, ValueError) as error:
        raise InstallError("launcher", "configuration prerequisite", "Cannot read the Launcher state directory setting.") from error
    for key in ("VIRTUAL_ENV", "CONDA_PREFIX", "CONDA_DEFAULT_ENV", "PYTHONHOME", "PYTHONPATH"):
        environment.pop(key, None)
    environment.update(POETRY_VIRTUALENVS_IN_PROJECT="true", POETRY_VIRTUALENVS_CREATE="true", PYTHONUTF8="1")
    with installation_lock(state_directory):
        poetry, projects, copies = preflight(repo, environment)
        for source, destination in copies:
            try:
                with tempfile.TemporaryDirectory(prefix=".launcher-install-", dir=destination.parent) as temporary:
                    staged = Path(temporary) / destination.name
                    staged.write_bytes(source.read_bytes())
                    shutil.copymode(source, staged)
                    os.link(staged, destination)  # Atomic creation; never replace an existing configuration.
            except OSError as error:
                raise InstallError(destination.parent.name, "configuration migration", str(error)) from error
            print(f"[{destination.parent.name}] Preserved legacy {destination.name} configuration.", flush=True)
        for project in projects:
            if project.create_environment:
                print(f"[{project.directory.name}] Creating Python 3.12 environment.", flush=True)
                run_command(project.directory, "create environment", [str(project.python), "-m", "venv", ".venv"], environment)
            print(f"[{project.directory.name}] Installing locked dependencies.", flush=True)
            run_command(project.directory, "install dependencies", [poetry, "install", "--only", "main", "--no-interaction"], environment)
        evaluation = repo / "app/slaves/cae_evaluation"
        python = evaluation / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        for step in ("prepare", "doctor"):
            print(f"[cae_evaluation] {step.capitalize()} shared Node runtime.", flush=True)
            run_command(evaluation, f"Node runtime {step}", [str(python), "-X", "utf8", "-m", "app", step], environment)
    print("Launcher and all five workers are installed. Start Launcher when ready.", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    try:
        install(Path(__file__).resolve().parents[2])
        return 0
    except (InstallError, OSError, ValueError, KeyError) as error:
        print(f"Installation failed: {error}\nFix the reported step, then rerun li_launcher_install.sh.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Installation interrupted; rerun li_launcher_install.sh to continue.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
