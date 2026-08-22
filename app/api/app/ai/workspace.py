from __future__ import annotations

import hashlib
import hmac
import json
import posixpath
import re
from dataclasses import dataclass
from typing import Any

from models import ExperimentSourceBundle

MAX_SOURCE_BYTES = 1024 * 1024
MAX_SOURCE_FILES = 256
REQUIRED_PATHS = frozenset({"experiment.tsx", "geometry.tsx", "material.tsx", "simulate.py"})
SOURCE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$")


class WorkspaceEditError(ValueError):
    pass


@dataclass(frozen=True)
class FileChunk:
    path: str
    sha256: str
    offset: int
    total_characters: int
    content: str
    next_offset: int | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "sha256": self.sha256,
            "offset": self.offset,
            "totalCharacters": self.total_characters,
            "content": self.content,
            "nextOffset": self.next_offset,
        }


class StagedExperiment:
    def __init__(self, bundle: ExperimentSourceBundle):
        self._bundle = ExperimentSourceBundle.model_validate(bundle.model_dump(mode="json"))
        validate_bundle_structure(self._bundle)
        self._source_hash = bundle_hash(self._bundle)
        self._initial_hash = self._source_hash
        self.revision = 0

    @property
    def source_hash(self) -> str:
        return self._source_hash

    @property
    def changed(self) -> bool:
        return self.source_hash != self._initial_hash

    @property
    def bundle(self) -> ExperimentSourceBundle:
        return ExperimentSourceBundle.model_validate(self._bundle.model_dump(mode="json"))

    def manifest(self) -> dict[str, Any]:
        return {
            "formatVersion": self._bundle.formatVersion,
            "revision": self.revision,
            "sourceHash": self.source_hash,
            "changed": self.changed,
            "files": [
                {
                    "path": path,
                    "bytes": len(source.encode("utf-8")),
                    "sha256": text_hash(source),
                }
                for path, source in sorted(self._bundle.files.items())
            ],
        }

    def read_file(self, path: str, *, offset: int, length: int) -> FileChunk:
        source = self._bundle.files.get(path)
        if source is None:
            raise WorkspaceEditError("Experiment source file was not found")
        if offset > len(source):
            raise WorkspaceEditError("Source offset is outside the file")
        content = source[offset : offset + length]
        next_offset = offset + len(content)
        return FileChunk(
            path=path,
            sha256=text_hash(source),
            offset=offset,
            total_characters=len(source),
            content=content,
            next_offset=next_offset if next_offset < len(source) else None,
        )

    def write_file(self, path: str, content: str, expected_sha256: str | None) -> dict[str, Any]:
        validate_source_path(path)
        current = self._bundle.files.get(path)
        if current is None:
            if expected_sha256 is not None:
                raise WorkspaceEditError("New source files require expectedSha256=null")
        elif expected_sha256 is None or not _secure_equal(text_hash(current), expected_sha256):
            raise WorkspaceEditError("Experiment source changed before this write")
        files = dict(self._bundle.files)
        files[path] = content
        candidate = ExperimentSourceBundle(
            formatVersion=6,
            files=files,
        )
        validate_bundle_structure(candidate)
        self._bundle = candidate
        self._source_hash = bundle_hash(candidate)
        self.revision += 1
        return {
            "path": path,
            "sha256": text_hash(content),
            "stagedRevision": self.revision,
            "sourceHash": self.source_hash,
        }

    def delete_file(self, path: str, expected_sha256: str) -> dict[str, Any]:
        validate_source_path(path)
        if path in REQUIRED_PATHS:
            raise WorkspaceEditError("Required Experiment source files cannot be deleted")
        current = self._bundle.files.get(path)
        if current is None:
            raise WorkspaceEditError("Experiment source file was not found")
        if not _secure_equal(text_hash(current), expected_sha256):
            raise WorkspaceEditError("Experiment source changed before this delete")
        files = dict(self._bundle.files)
        del files[path]
        candidate = ExperimentSourceBundle(
            formatVersion=6,
            files=files,
        )
        validate_bundle_structure(candidate)
        self._bundle = candidate
        self._source_hash = bundle_hash(candidate)
        self.revision += 1
        return {
            "path": path,
            "deleted": True,
            "stagedRevision": self.revision,
            "sourceHash": self.source_hash,
        }


def validate_source_path(path: str) -> None:
    if (
        not path
        or len(path) > 256
        or "\\" in path
        or path.startswith("/")
        or posixpath.normpath(path) != path
        or path.startswith("../")
        or path.endswith(".d.ts")
        or any(
            segment in {"", ".", ".."} or SOURCE_SEGMENT_RE.fullmatch(segment) is None
            for segment in path.split("/")
        )
        or (path != "simulate.py" and not path.endswith((".ts", ".tsx")))
    ):
        raise WorkspaceEditError("Experiment source file path is not allowed")


def validate_bundle_structure(bundle: ExperimentSourceBundle) -> None:
    if len(bundle.files) > MAX_SOURCE_FILES:
        raise WorkspaceEditError("Experiment source bundle exceeds 256 files")
    folded_paths: set[str] = set()
    for path in bundle.files:
        validate_source_path(path)
        folded = path.casefold()
        if folded in folded_paths:
            raise WorkspaceEditError("Experiment source paths differ only by case")
        folded_paths.add(folded)
    if not REQUIRED_PATHS.issubset(bundle.files):
        raise WorkspaceEditError("Experiment source bundle is missing a required file")
    total = 0
    for path, source in bundle.files.items():
        try:
            size = len(source.encode("utf-8", errors="strict"))
        except UnicodeEncodeError as error:
            raise WorkspaceEditError(f"Experiment source {path} must be valid UTF-8") from error
        if size > MAX_SOURCE_BYTES:
            raise WorkspaceEditError(f"Experiment source {path} exceeds 1 MiB")
        total += size
    if total > MAX_SOURCE_BYTES:
        raise WorkspaceEditError("Experiment source bundle exceeds 1 MiB")
    if not bundle.files["experiment.tsx"].strip() or not bundle.files["simulate.py"].strip():
        raise WorkspaceEditError("Experiment program sources must not be empty")


def bundle_hash(bundle: ExperimentSourceBundle) -> str:
    canonical_bundle = {
        "formatVersion": bundle.formatVersion,
        "files": {path: bundle.files[path] for path in sorted(bundle.files)},
    }
    canonical = json.dumps(
        canonical_bundle,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def text_hash(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _secure_equal(left: str, right: str) -> bool:
    return len(right) == 64 and hmac.compare_digest(left, right)
