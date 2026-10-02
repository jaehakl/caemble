"""Prepare the shared Node release using only the Python standard library."""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile
import tempfile


REQUIRED_FILES = ("caemble.cjs", "worker.cjs", "caemble-core.d.ts", "cad-jsx.d.ts", "lib.es5.d.ts")


def bundle_metadata(directory: Path) -> bytes:
    try:
        raw = (directory / "build-info.json").read_bytes()
        if json.loads(raw)["version"] != "1":
            raise ValueError("unsupported build metadata version")
        for name in REQUIRED_FILES:
            if not (directory / name).is_file():
                raise ValueError(f"missing runtime asset: {name}")
        return raw
    except (OSError, ValueError, KeyError) as error:
        raise RuntimeError(f"Node bundle is missing or stale: {error}") from error


def current_runtime(repo: Path) -> Path:
    try:
        identity = (repo / ".data/node-runtime/current").read_text(encoding="utf-8").strip()
        if not re.fullmatch(r"[0-9a-f]{64}", identity):
            raise ValueError("invalid runtime identity")
        directory = repo / ".data/node-runtime" / identity
        bundle_metadata(directory)
        return directory
    except (OSError, ValueError) as error:
        raise RuntimeError(f"Node bundle is not prepared: {error}") from error


@contextlib.contextmanager
def installation_lock(cache: Path):
    # An OS lock is released even if a launcher is terminated during preparation.
    with (cache / "prepare.lock").open("a+b") as stream:
        if stream.seek(0, os.SEEK_END) == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def prepare_runtime(repo: Path) -> dict:
    cache = repo / ".data/node-runtime"
    cache.mkdir(parents=True, exist_ok=True)
    with installation_lock(cache), tarfile.open(repo / "deployment/caemble.tar.gz", "r:gz") as archive:
        members = archive.getmembers()
        metadata = next((entry for entry in members
                         if entry.name.removeprefix("./") == "node/build-info.json" and entry.isfile()), None)
        if metadata is None:
            raise RuntimeError("Release archive has no node/build-info.json.")
        with archive.extractfile(metadata) as stream:
            expected = stream.read()
        identity = hashlib.sha256(expected).hexdigest()
        destination = cache / identity
        try:
            installed = bundle_metadata(destination) != expected
        except RuntimeError:
            installed = True
        with tempfile.TemporaryDirectory(prefix=".prepare-", dir=cache) as temporary:
            staging = Path(temporary)
            if installed:
                prepared = staging / "node"
                prepared.mkdir()
                for entry in members:
                    name = entry.name.removeprefix("./")
                    if not name.startswith("node/") or (entry.isdir() and name.rstrip("/") == "node"):
                        continue
                    name = name.removeprefix("node/")
                    if not entry.isfile() or name in {"", ".", ".."} or any(c in name for c in "/\\:"):
                        raise RuntimeError(f"Unexpected Node archive entry: {entry.name}")
                    with archive.extractfile(entry) as source, (prepared / name).open("wb") as target:
                        shutil.copyfileobj(source, target)
                bundle_metadata(prepared)
                # Complete versions are immutable. Only a previously incomplete
                # installation of this exact version needs to be replaced.
                previous = cache / f".incomplete-{identity}"
                if destination.exists():
                    destination.rename(previous)
                try:
                    prepared.rename(destination)
                except OSError:
                    if previous.exists():
                        previous.rename(destination)
                    raise
                if previous.exists():
                    shutil.rmtree(previous)
            selection = staging / "current"
            selection.write_text(identity, encoding="utf-8")
            selection.replace(cache / "current")
        return {"installed": installed, "runtime_id": identity, "directory": str(destination)}


if __name__ == "__main__":
    try:
        print(json.dumps(prepare_runtime(Path(__file__).resolve().parents[3])))
    except Exception as error:
        print(f"Node bundle preparation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from None
