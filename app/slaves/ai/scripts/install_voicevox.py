from __future__ import annotations

import hashlib
import os
import platform
import stat
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from dotenv import dotenv_values


VOICEVOX_CORE_VERSION = "0.16.4"
VOICEVOX_INSTALLER_USER_AGENT = "gpstation-ai-voicevox-installer"
AI_DIR = Path(__file__).resolve().parent.parent
DOWNLOADERS = {
    ("Windows", "x86_64"): (
        "download-windows-x64.exe",
        "8293658d3af5a8cf753b292747110e46ca4351366dd9705172444160dbdfb3b9",
    ),
    ("Linux", "x86_64"): (
        "download-linux-x64",
        "9d53fe39b3a6de7ebd10b779533ad8bd0ee09bc23ce8a9337eef23d281d28a1b",
    ),
}


def normalize_machine(machine: str) -> str:
    value = machine.lower()
    return "x86_64" if value in {"amd64", "x86_64"} else value


def resolve_output_dir() -> Path:
    dotenv = dotenv_values(AI_DIR / ".env")
    configured = os.environ.get("VOICEVOX_RUNTIME_DIR") or dotenv.get("VOICEVOX_RUNTIME_DIR")
    output_dir = Path(configured or AI_DIR / "voicevox_runtime").expanduser()
    return output_dir if output_dir.is_absolute() else AI_DIR / output_dir


def run_downloader(command: list[str]) -> None:
    environment = os.environ.copy()
    try:
        subprocess.run(command, check=True, env=environment)
    except subprocess.CalledProcessError:
        token_names = [name for name in ("GH_TOKEN", "GITHUB_TOKEN") if environment.get(name)]
        if not token_names:
            raise
        retry_environment = environment.copy()
        for name in token_names:
            retry_environment.pop(name, None)
        print(
            "VOICEVOX downloader failed with configured GitHub credentials; retrying anonymously.",
            file=sys.stderr,
        )
        subprocess.run(command, check=True, env=retry_environment)


def main() -> int:
    target = (platform.system(), normalize_machine(platform.machine()))
    downloader = DOWNLOADERS.get(target)
    if downloader is None:
        supported = ", ".join(f"{system} {machine}" for system, machine in DOWNLOADERS)
        raise RuntimeError(f"Unsupported platform {target[0]} {target[1]}; supported: {supported}")

    filename, expected_sha256 = downloader
    url = f"https://github.com/VOICEVOX/voicevox_core/releases/download/{VOICEVOX_CORE_VERSION}/{filename}"
    output_dir = resolve_output_dir()
    output_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="voicevox-downloader-") as temp_dir:
        executable = Path(temp_dir) / filename
        request = urllib.request.Request(url, headers={"User-Agent": VOICEVOX_INSTALLER_USER_AGENT})
        with urllib.request.urlopen(request) as response, executable.open("wb") as destination:
            while chunk := response.read(1024 * 1024):
                destination.write(chunk)

        actual_sha256 = hashlib.sha256(executable.read_bytes()).hexdigest()
        if actual_sha256 != expected_sha256:
            raise RuntimeError(
                f"VOICEVOX downloader SHA-256 mismatch: expected {expected_sha256}, got {actual_sha256}"
            )
        if platform.system() != "Windows":
            executable.chmod(executable.stat().st_mode | stat.S_IXUSR)

        command = [
            str(executable),
            "--only",
            "c-api",
            "onnxruntime",
            "models",
            "dict",
            "--models-pattern",
            "[0-9]*.vvm",
            "--c-api-version",
            VOICEVOX_CORE_VERSION,
            "--output",
            str(output_dir),
        ]
        print("VOICEVOX model terms will be shown by the official downloader.", file=sys.stderr)
        run_downloader(command)

    print(f"VOICEVOX runtime installed at {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
