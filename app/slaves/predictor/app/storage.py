"""Owner-scoped, checksum-verified atomic artifacts in a registered local root."""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import threading
import time
import uuid

import psutil

from .errors import PredictionError


def encode_json(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def safe_id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise PredictionError("invalid-reference", "Asset identity must be an opaque identifier, not a filesystem path.")
    return value


def check_cancel(cancel: threading.Event | None) -> None:
    if cancel is not None and cancel.is_set():
        raise PredictionError("cancelled", "Prediction request was cancelled.")


class ArtifactStore:
    def __init__(self, root: Path, owner_id: str, launcher_id: str):
        if not owner_id or not launcher_id:
            raise PredictionError("configuration", "Trusted launcher ownership is required.")
        self.root = root.expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        identity_file = self.root / "storage-id"
        try:
            with identity_file.open("x", encoding="utf-8") as stream:
                stream.write(str(uuid.uuid4()))
                stream.flush()
                os.fsync(stream.fileno())
        except FileExistsError:
            pass
        self.storage_id = str(uuid.UUID(identity_file.read_text(encoding="utf-8").strip()))
        self.launcher_id = launcher_id
        namespace = hashlib.sha256(owner_id.encode("utf-8")).hexdigest()
        self.namespace = self.root / "owners" / namespace
        self.namespace.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def transaction(self, cancel: threading.Event | None = None, *, operation_id: str | None = None):
        """Serialize disk reads/writes across Predictor sessions for this owner."""
        if os.name == "nt":
            import msvcrt
        else:
            import fcntl
        directory = self.path("operations", operation_id) if operation_id is not None else self.namespace
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / ".storage.lock").open("a+b") as stream:
            if stream.tell() == 0:
                stream.write(b"\0")
                stream.flush()
            while True:
                check_cancel(cancel)
                try:
                    stream.seek(0)
                    if os.name == "nt":
                        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError as error:
                    if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise
                    if cancel is None:
                        time.sleep(.05)
                    else:
                        cancel.wait(.05)
            try:
                check_cancel(cancel)
                yield
            finally:
                stream.seek(0)
                if os.name == "nt":
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)

    def path(self, kind: str, identity: str, revision: int | None = None) -> Path:
        if kind not in ("models", "datasets", "tombstones", "leases", "read-leases", "operations"):
            raise PredictionError("invalid-reference", "Unknown artifact category.")
        path = self.namespace / kind / safe_id(identity)
        if revision is not None:
            if type(revision) is not int or revision < 1:
                raise PredictionError("invalid-reference", "Artifact revision must be a positive integer.")
            path /= str(revision)
        resolved = path.resolve()
        if not resolved.is_relative_to(self.namespace.resolve()):
            raise PredictionError("invalid-reference", "Artifact reference escapes the managed storage root.")
        return resolved

    def lease(self, identity: str, revision: int, handle: str) -> None:
        directory = self.path("leases", identity, revision)
        directory.mkdir(parents=True, exist_ok=True)
        process = psutil.Process()
        (directory / f"{safe_id(handle)}.json").write_bytes(encode_json({"pid": process.pid, "createdAt": process.create_time()}))

    def release_lease(self, identity: str, revision: int, handle: str) -> None:
        (self.path("leases", identity, revision) / f"{safe_id(handle)}.json").unlink(missing_ok=True)

    def assert_unused(self, identity: str, revision: int | None, kind: str = "models") -> None:
        directories = [self.path("read-leases", f"{kind}-{identity}", revision)]
        if kind == "models":
            directories.append(self.path("leases", identity, revision))
        for directory in directories:
            self._assert_no_live_leases(directory)

    def _assert_no_live_leases(self, directory: Path) -> None:
        if not directory.exists():
            return
        for path in directory.rglob("*.json"):
            try:
                lease = json.loads(path.read_bytes())
                process = psutil.Process(lease["pid"])
                if process.create_time() == lease["createdAt"] and process.is_running():
                    raise PredictionError("model-in-use", "Release the model from all Predictor sessions before deleting its files.")
            except (psutil.NoSuchProcess, FileNotFoundError):
                pass
            except (psutil.AccessDenied, KeyError, TypeError, json.JSONDecodeError) as error:
                raise PredictionError("model-in-use", "Cannot verify an existing model lease; its files were retained.") from error
            path.unlink(missing_ok=True)

    @contextmanager
    def read_lease(self, kind: str, identity: str, revision: int, cancel=None, *, allow_missing: bool = False):
        """Keep immutable revision bytes alive without holding the owner lock during IO."""
        handle = str(uuid.uuid4())
        directory = self.path("read-leases", f"{kind}-{safe_id(identity)}", revision)
        with self.transaction(cancel):
            if not allow_missing and not self.path(kind, identity, revision).is_dir():
                raise PredictionError("artifact-missing", "Saved artifact files are missing on this storage.")
            directory.mkdir(parents=True, exist_ok=True)
            process = psutil.Process()
            (directory / f"{handle}.json").write_bytes(encode_json({"pid": process.pid, "createdAt": process.create_time()}))
        try:
            yield
        finally:
            (directory / f"{handle}.json").unlink(missing_ok=True)

    def read(self, kind: str, identity: str, revision: int, budget: int | None = None,
             cancel: threading.Event | None = None, verify: bool = True) -> tuple[dict, Path, str]:
        path = self.path(kind, identity, revision)
        try:
            raw = (path / "manifest.json").read_bytes()
            manifest = json.loads(raw)
            if manifest.get("kind") != f"caemble.prediction.{kind[:-1]}.artifact" or manifest.get("version") != 1:
                raise PredictionError("artifact-version", "Unsupported artifact format.")
            if manifest.get("identity") != identity or manifest.get("revision") != revision:
                raise PredictionError("artifact-checksum", "Artifact identity differs from its manifest.")
            if not isinstance(manifest.get("files"), list) or len({file["name"] for file in manifest["files"]}) != len(manifest["files"]):
                raise PredictionError("artifact-checksum", "Artifact file names must be unique.")
            total = sum(file["byteLength"] for file in manifest["files"])
            if budget is not None and total > budget:
                raise PredictionError("memory-limit", f"Artifact needs {total:,} bytes; {budget:,} bytes are available.")
            for file in manifest["files"]:
                name = file["name"]
                if (type(file["byteLength"]) is not int or file["byteLength"] < 0
                        or not isinstance(file["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", file["sha256"])):
                    raise PredictionError("artifact-checksum", "Artifact file metadata is invalid.")
                if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or name in (".", "..", "manifest.json"):
                    raise PredictionError("artifact-checksum", "Artifact manifest contains an invalid file name.")
                unresolved = path / name
                target = unresolved.resolve()
                if not target.is_relative_to(path) or unresolved.is_symlink():
                    raise PredictionError("artifact-checksum", "Artifact file escapes its revision directory.")
                if target.stat().st_size != file["byteLength"]:
                    raise PredictionError("artifact-checksum", "Artifact file length differs from its manifest.")
                if verify:
                    digest = hashlib.sha256()
                    with target.open("rb") as stream:
                        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                            check_cancel(cancel)
                            digest.update(chunk)
                    if digest.hexdigest() != file["sha256"]:
                        raise PredictionError("artifact-checksum", "Artifact file checksum differs from its manifest.")
            return manifest, path, hashlib.sha256(raw).hexdigest()
        except FileNotFoundError:
            raise PredictionError("artifact-missing", "Saved artifact files are missing on this storage.") from None
        except PredictionError:
            raise
        except (KeyError, TypeError, ValueError) as error:
            raise PredictionError("artifact-checksum", "Saved artifact manifest is invalid.") from error

    def write(self, kind: str, identity: str, revision: int, metadata: dict, writer,
              cancel: threading.Event | None = None, *, publication_lock: bool = False) -> tuple[dict, Path, str]:
        target = self.path(kind, identity, revision)
        if kind == "models" and self.deleted(identity, revision):
            raise PredictionError("deleted", "This model revision has been deleted.")
        if target.exists():
            existing = self.read(kind, identity, revision)
            if existing[0]["metadata"] != metadata:
                raise PredictionError("revision-conflict", "Artifact revision already contains different content.")
            return existing
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.parent / f".pending-{uuid.uuid4()}"
        temporary.mkdir()
        try:
            check_cancel(cancel)
            writer(temporary)
            files = []
            for file in sorted(temporary.iterdir()):
                check_cancel(cancel)
                if not file.is_file() or file.name == "manifest.json":
                    raise PredictionError("artifact-save", "Artifact writer produced unsupported files.")
                digest = hashlib.sha256()
                with file.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        check_cancel(cancel)
                        digest.update(chunk)
                files.append({"name": file.name, "byteLength": file.stat().st_size, "sha256": digest.hexdigest()})
            manifest = {"kind": f"caemble.prediction.{kind[:-1]}.artifact", "version": 1,
                        "identity": identity, "revision": revision, "metadata": metadata, "files": files}
            with (temporary / "manifest.json").open("wb") as stream:
                stream.write(encode_json(manifest))
                stream.flush()
                os.fsync(stream.fileno())
            check_cancel(cancel)
            try:
                with self.transaction(cancel) if publication_lock else nullcontext():
                    if (kind == "models" and self.deleted(identity, revision)) or (kind == "datasets" and self.dataset_deleted(identity)):
                        raise PredictionError("deleted", "This asset has been logically deleted.")
                    os.replace(temporary, target)
            except OSError:
                if not target.exists():
                    raise
                existing = self.read(kind, identity, revision)
                if existing[0]["metadata"] != metadata:
                    raise PredictionError("revision-conflict", "A concurrent write published different content.")
                return existing
            return self.read(kind, identity, revision)
        finally:
            if temporary.exists():
                self._remove(temporary)

    def _remove(self, path: Path) -> None:
        resolved = path.resolve()
        if resolved == self.namespace or not resolved.is_relative_to(self.namespace.resolve()):
            raise PredictionError("invalid-reference", "Removal target escapes managed storage.")
        if path.is_symlink() or any(child.is_symlink() for child in path.rglob("*")):
            raise PredictionError("invalid-reference", "Managed artifact directories must not contain symbolic links.")
        shutil.rmtree(resolved)

    def latest_dataset(self, identity: str) -> int:
        try:
            return int((self.path("datasets", identity) / "latest").read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            raise PredictionError("dataset-missing", "Dataset is not imported on this storage.") from None

    def discard_unpublished_dataset(self, identity: str, cancel: threading.Event | None = None) -> None:
        """An explicit import may retry an interrupted save; inspection never commits it."""
        parent = self.path("datasets", identity)
        if not parent.exists():
            return
        current = self.latest_dataset(identity) if (parent / "latest").exists() else 0
        for child in parent.iterdir():
            if child.is_dir() and child.name.isdigit() and int(child.name) > current and not (parent / "retained" / child.name).exists():
                check_cancel(cancel)
                self.read("datasets", identity, int(child.name))
                self._remove(child)

    def publish_dataset(self, identity: str, revision: int) -> None:
        parent = self.path("datasets", identity)
        previous = parent / "latest"
        if previous.exists() and int(previous.read_text(encoding="utf-8")) > revision:
            raise PredictionError("revision-conflict", "Cannot replace a newer local Dataset revision.")
        retired = [child for child in parent.iterdir() if child.is_dir() and child.name.isdigit()
                   and int(child.name) != revision and not (parent / "retained" / child.name).exists()]
        for child in retired:
            self.assert_unused(identity, int(child.name), "datasets")
        for child in retired:
            manifest, _, checksum = self.read("datasets", identity, int(child.name))
            if manifest["metadata"].get("sourceKind") == "local":
                receipts = parent / "receipts"
                receipts.mkdir(exist_ok=True)
                temporary = receipts / f".pending-{uuid.uuid4()}"
                temporary.write_bytes(encode_json({**manifest["metadata"], "files": manifest["files"],
                    "manifestChecksum": checksum, "registrationReceipt": True, "payloadAvailable": False}))
                os.replace(temporary, receipts / f"{child.name}.json")
        pending = parent / f".latest-{uuid.uuid4()}"
        pending.write_text(str(revision), encoding="utf-8")
        os.replace(pending, previous)
        for child in retired:
            self._remove(child)

    def list(self, kind: str, *, verify: bool = True) -> list[dict]:
        directory = self.namespace / kind
        result = []
        if not directory.exists():
            return result
        for identity in sorted(directory.iterdir()):
            if not identity.is_dir() or identity.name.startswith("."):
                continue
            if kind == "datasets" and not (identity / "latest").exists() and not (identity / "retained").exists():
                continue
            revisions = [int(path.name) for path in identity.iterdir() if path.is_dir() and path.name.isdigit()]
            if kind == "datasets":
                latest = self.latest_dataset(identity.name) if (identity / "latest").exists() else None
                revisions = [revision for revision in revisions if revision == latest or (identity / "retained" / str(revision)).exists()]
            if kind == "datasets":
                receipts = identity / "receipts"
                if receipts.exists():
                    for path in sorted(receipts.glob("*.json"), key=lambda path: int(path.stem)):
                        receipt = json.loads(path.read_bytes())
                        if receipt["revision"] not in revisions:
                            result.append({**receipt, "storageId": self.storage_id, "launcherId": self.launcher_id,
                                           "verified": False, "payloadAvailable": False})
            for revision in revisions:
                try:
                    manifest, _, checksum = self.read(kind, identity.name, revision, verify=verify)
                    result.append({**manifest["metadata"], "files": manifest["files"], "manifestChecksum": checksum,
                                   "storageId": self.storage_id, "launcherId": self.launcher_id,
                                   "available": True, "verified": verify,
                                   **({"payloadAvailable": True} if kind == "datasets" else {})})
                except PredictionError as error:
                    result.append({"modelId" if kind == "models" else "datasetId": identity.name,
                                   "revision": revision, "available": False, "error": {"code": error.code, "message": str(error)}})
        return result

    def deleted(self, identity: str, revision: int) -> bool:
        tombstone = self.path("tombstones", identity)
        return (tombstone / "all").exists() or (tombstone / str(revision)).exists()

    def dataset_deleted(self, identity: str) -> bool:
        tombstone = self.path("tombstones", f"dataset-{safe_id(identity)}")
        return (tombstone / "all").exists()

    def delete(self, kind: str, identity: str, revision: int | None = None) -> None:
        target = self.path(kind, identity, revision)
        self.assert_unused(identity, revision, kind)
        if kind == "models":
            self.assert_unused(identity, revision)
            tombstone = self.path("tombstones", identity)
            tombstone.mkdir(parents=True, exist_ok=True)
            (tombstone / (str(revision) if revision else "all")).touch()
        elif kind == "datasets":
            tombstone = self.path("tombstones", f"dataset-{safe_id(identity)}")
            tombstone.mkdir(parents=True, exist_ok=True)
            (tombstone / "all").touch()
        if target.exists():
            self._remove(target)

    def remove_replica(self, kind: str, identity: str, revision: int, cancel=None) -> None:
        """Removing one copy never creates the logical deletion tombstone."""
        if kind not in ("models", "datasets"):
            raise PredictionError("invalid-reference", "Unknown artifact category.")
        removed = None
        with self.transaction(cancel):
            self.assert_unused(identity, revision, kind)
            target = self.path(kind, identity, revision)
            if target.exists():
                removed = target.parent / f".removing-{uuid.uuid4()}"
                os.replace(target, removed)
            if kind == "datasets":
                (target.parent / "retained" / str(revision)).unlink(missing_ok=True)
                latest = target.parent / "latest"
                if latest.exists() and latest.read_text(encoding="utf-8").strip() == str(revision):
                    latest.unlink()
        if removed is not None:
            self._remove(removed)

    def publish_replica(self, kind: str, identity: str, revision: int, staged: Path, checksum: str, cancel=None) -> bool:
        """Publish previously verified bytes; a collision compares the exact manifest."""
        with self.transaction(cancel):
            if (kind == "models" and self.deleted(identity, revision)) or (kind == "datasets" and self.dataset_deleted(identity)):
                raise PredictionError("deleted", "This asset has been logically deleted.")
            target = self.path(kind, identity, revision)
            reused = target.exists()
            if reused:
                actual = hashlib.sha256((target / "manifest.json").read_bytes()).hexdigest()
                if actual != checksum:
                    raise PredictionError("revision-conflict", "This identity and revision already contain different content.")
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(staged, target)
            if kind == "datasets":
                retained = target.parent / "retained"
                retained.mkdir(exist_ok=True)
                (retained / str(revision)).touch()
            return reused

    def save_receipt(self, operation_id: str, receipt: dict) -> dict:
        directory = self.path("operations", operation_id)
        directory.mkdir(parents=True, exist_ok=True)
        pending = directory / f".pending-{uuid.uuid4()}"
        with pending.open("wb") as stream:
            stream.write(encode_json(receipt))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, directory / "receipt.json")
        return receipt

    def receipt(self, operation_id: str) -> dict | None:
        try:
            return json.loads((self.path("operations", operation_id) / "receipt.json").read_bytes())
        except FileNotFoundError:
            return None
