"""Portable inert artifact archives. Artifact v1 files are copied byte for byte."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shutil
import stat
import zipfile

from .dataset import DatasetReader, references
from .errors import PredictionError
from .models import implementation_for
from .storage import check_cancel, encode_json, safe_id

CHUNK_BYTES = 8 * 1024 * 1024


def validate_content(path: Path, manifest: dict, kind: str) -> None:
    """Check inert JSON/NumPy contracts without loading training arrays into RAM."""
    names = {entry["name"] for entry in manifest["files"]}
    identity, revision = manifest["identity"], manifest["revision"]
    if kind == "dataset":
        content = json.loads((path / "dataset.json").read_bytes())
        DatasetReader.validate(content)
        if (content["datasetId"] != identity or content["revision"] != revision
                or content["fingerprint"] != manifest["metadata"]["fingerprint"]):
            raise PredictionError("artifact-checksum", "Dataset archive identity differs from its manifest.")
        expected = {"dataset.json"} | {f"{ref['sha256']}.object" for ref in references(content).values()}
    else:
        content = json.loads((path / "model.json").read_bytes())
        metadata = content["metadata"]
        if metadata["modelId"] != identity or metadata["revision"] != revision:
            raise PredictionError("artifact-checksum", "Model archive identity differs from its manifest.")
        expected = implementation_for(metadata["definition"]).validate_artifact(path, manifest, content)
    if names != expected:
        raise PredictionError("artifact-checksum", "Archive does not contain exactly the complete artifact file set.")


def create_archive(store, kind: str, identity: str, revision: int, target: Path, cancel=None) -> dict:
    manifest, path, checksum = store.read(kind + "s", identity, revision, cancel=cancel)
    validate_content(path, manifest, kind)
    package = {"kind": "caemble.prediction.archive", "version": 1, "assetKind": kind,
               "identity": identity, "revision": revision, "manifestSha256": checksum}
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for name in ["package.json", "manifest.json", *sorted(entry["name"] for entry in manifest["files"])]:
            check_cancel(cancel)
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            with archive.open(info, "w", force_zip64=True) as destination:
                if name == "package.json":
                    destination.write(encode_json(package))
                else:
                    with (path / name).open("rb") as source:
                        for chunk in iter(lambda: source.read(1024 * 1024), b""):
                            check_cancel(cancel)
                            destination.write(chunk)
    return {"identity": identity, "revision": revision, "manifest_sha256": checksum,
            "format_version": 1, "files": manifest["files"]}


def object_manifest(path: Path, cancel=None) -> dict:
    digest, chunks, length = hashlib.sha256(), [], 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK_BYTES), b""):
            check_cancel(cancel)
            digest.update(chunk)
            length += len(chunk)
            chunks.append({"sha256": hashlib.sha256(chunk).hexdigest(), "byteLength": len(chunk)})
    return {"encoding": "base64", "sha256": digest.hexdigest(), "byteLength": length, "chunks": chunks}


def unpack_archive(archive_path: Path, target: Path, kind: str, identity: str, revision: int,
                   expected_checksum: str, cancel=None, metadata_budget: int = 64 * 1024 * 1024) -> dict:
    safe_id(identity)
    if type(revision) is not int or revision < 1 or kind not in ("model", "dataset"):
        raise PredictionError("invalid-reference", "Archive target is invalid.")
    target.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            infos = archive.infolist()
            names = [entry.filename for entry in infos]
            if len(infos) > 10000 or len(set(name.casefold() for name in names)) != len(names):
                raise PredictionError("archive-format", "Archive contains too many or duplicate file names.")
            for entry in infos:
                mode = entry.external_attr >> 16
                if (not re.fullmatch(r"[A-Za-z0-9_.-]+", entry.filename) or entry.filename in (".", "..")
                        or entry.is_dir() or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG))
                        or entry.compress_type != zipfile.ZIP_STORED or entry.flag_bits & 1
                        or entry.file_size != entry.compress_size):
                    raise PredictionError("archive-format", "Archive contains an unsupported path or file format.")
            if "package.json" not in names or "manifest.json" not in names:
                raise PredictionError("archive-format", "Archive has no package or artifact manifest.")
            if any(archive.getinfo(name).file_size > metadata_budget for name in names if name.endswith(".json")):
                raise PredictionError("memory-limit", "Archive metadata exceeds the available memory budget.")
            package = json.loads(archive.read("package.json"))
            if package != {"kind": "caemble.prediction.archive", "version": 1, "assetKind": kind,
                           "identity": identity, "revision": revision, "manifestSha256": expected_checksum}:
                raise PredictionError("artifact-checksum", "Archive package differs from the requested immutable revision.")
            raw = archive.read("manifest.json")
            if hashlib.sha256(raw).hexdigest() != expected_checksum:
                raise PredictionError("artifact-checksum", "Archive manifest differs from the registered revision.")
            manifest = json.loads(raw)
            if (manifest.get("kind") != f"caemble.prediction.{kind}.artifact" or manifest.get("version") != 1
                    or manifest.get("identity") != identity or manifest.get("revision") != revision):
                raise PredictionError("artifact-version", "Unsupported artifact identity or format.")
            expected = {entry["name"]: entry for entry in manifest["files"]}
            if len(expected) != len(manifest["files"]) or set(names) != {"package.json", "manifest.json", *expected}:
                raise PredictionError("artifact-checksum", "Archive file inventory differs from its manifest.")
            total = sum(entry.file_size for entry in infos)
            if total > shutil.disk_usage(target).free:
                raise PredictionError("storage-full", "Insufficient disk space to restore this artifact.")
            (target / "manifest.json").write_bytes(raw)
            for name, entry in expected.items():
                check_cancel(cancel)
                if (type(entry["byteLength"]) is not int or entry["byteLength"] < 0
                        or archive.getinfo(name).file_size != entry["byteLength"]):
                    raise PredictionError("artifact-checksum", "Archive file length differs from its manifest.")
                digest, length = hashlib.sha256(), 0
                with archive.open(name) as source, (target / name).open("xb") as destination:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        check_cancel(cancel)
                        digest.update(chunk)
                        length += len(chunk)
                        destination.write(chunk)
                if length != entry["byteLength"] or digest.hexdigest() != entry["sha256"]:
                    raise PredictionError("artifact-checksum", "Archive file checksum differs from its manifest.")
            validate_content(target, manifest, kind)
            return {"identity": identity, "revision": revision, "manifest_sha256": expected_checksum,
                    "format_version": 1, "files": manifest["files"]}
    except PredictionError:
        raise
    except (KeyError, TypeError, ValueError, zipfile.BadZipFile, EOFError) as error:
        raise PredictionError("archive-format", "Archive metadata or file format is invalid.") from error
