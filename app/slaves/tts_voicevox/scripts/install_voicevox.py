from __future__ import annotations

import hashlib
import argparse
import io
import os
import platform
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from dotenv import dotenv_values


VOICEVOX_CORE_VERSION = "0.16.4"
VOICEVOX_ONNXRUNTIME_VERSION = "voicevox_onnxruntime-1.17.3"
# cuDNN's Windows prerequisite, linked by NVIDIA's cuDNN 8.9.3 installation guide.
ZLIB_URL = "https://www.winimage.com/zLibDll/zlib123dllx64.zip"
ZLIB_SHA256 = "fd324c6923aa4f45a60413665e0b68bb34a7779d0861849e02d2711ff8efb9a4"
VOICEVOX_INSTALLER_USER_AGENT = "caemble-tts-voicevox-installer"
APP_DIR = Path(__file__).resolve().parent.parent
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
    dotenv = dotenv_values(APP_DIR / ".env")
    configured = os.environ.get("VOICEVOX_RUNTIME_DIR") or dotenv.get("VOICEVOX_RUNTIME_DIR")
    output_dir = Path(configured or APP_DIR / "voicevox_runtime").expanduser()
    return output_dir if output_dir.is_absolute() else APP_DIR / output_dir


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


def install_windows_zlib(output_dir: Path) -> None:
    request = urllib.request.Request(ZLIB_URL, headers={"User-Agent": VOICEVOX_INSTALLER_USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != ZLIB_SHA256:
        raise RuntimeError("Windows zlib archive SHA-256 mismatch")
    directory = output_dir / "additional_libraries"
    directory.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        (directory / "zlibwapi.dll").write_bytes(archive.read("dll_x64/zlibwapi.dll"))
        (directory / "zlib-readme.txt").write_bytes(archive.read("readme.txt"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Install the independent VOICEVOX CPU/CUDA runtime")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cuda")
    args = parser.parse_args()
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
            "additional-libraries",
            "models",
            "dict",
            "--models-pattern",
            "[0-9]*.vvm",
            "--c-api-version",
            VOICEVOX_CORE_VERSION,
            "--onnxruntime-version",
            VOICEVOX_ONNXRUNTIME_VERSION,
            "--additional-libraries-version",
            "0.2.1",
            "--models-version",
            VOICEVOX_CORE_VERSION,
            "--devices",
            args.device,
            "--output",
            str(output_dir),
        ]
        print("VOICEVOX model terms will be shown by the official downloader.", file=sys.stderr)
        run_downloader(command)

    if target[0] == "Windows" and args.device == "cuda":
        install_windows_zlib(output_dir)

    print(f"VOICEVOX runtime installed at {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
