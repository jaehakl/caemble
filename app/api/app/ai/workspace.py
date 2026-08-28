from __future__ import annotations

import hashlib
import hmac
import json
import posixpath
import re
from dataclasses import dataclass
from typing import Any

from models import ExperimentSourceBundle

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
        for path in self._bundle.files:
            require_safe_source_path(path)
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
        require_safe_source_path(path)
        current = self._bundle.files.get(path)
        if current is None:
            if expected_sha256 is not None:
                raise WorkspaceEditError("New source files require expectedSha256=null")
        elif expected_sha256 is None or not _secure_equal(text_hash(current), expected_sha256):
            raise WorkspaceEditError("Experiment source changed before this write")
        files = dict(self._bundle.files)
        files[path] = content
        candidate = ExperimentSourceBundle(files=files)
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
        require_safe_source_path(path)
        current = self._bundle.files.get(path)
        if current is None:
            raise WorkspaceEditError("Experiment source file was not found")
        if not _secure_equal(text_hash(current), expected_sha256):
            raise WorkspaceEditError("Experiment source changed before this delete")
        files = dict(self._bundle.files)
        del files[path]
        candidate = ExperimentSourceBundle(files=files)
        self._bundle = candidate
        self._source_hash = bundle_hash(candidate)
        self.revision += 1
        return {
            "path": path,
            "deleted": True,
            "stagedRevision": self.revision,
            "sourceHash": self.source_hash,
        }


class StagedCalculation:
    def __init__(
        self,
        *,
        calculation_id: int | None,
        experiment_id: int,
        name: str,
        description: str,
        source_code: str,
        editable: bool,
        reference_experiment: ExperimentSourceBundle,
    ):
        self.calculation_id = calculation_id
        self.experiment_id = experiment_id
        self.name = name
        self.description = description
        self.editable = editable
        self._source_code = source_code
        self._source_hash = text_hash(source_code)
        self._initial_hash = self._source_hash
        self.reference_experiment = StagedExperiment(reference_experiment)
        self.revision = 0

    @property
    def source_hash(self) -> str:
        return self._source_hash

    @property
    def changed(self) -> bool:
        return self.source_hash != self._initial_hash

    @property
    def source_code(self) -> str:
        return self._source_code

    def manifest(self) -> dict[str, Any]:
        return {
            "kind": "calculation",
            "calculationId": self.calculation_id,
            "experimentId": self.experiment_id,
            "revision": self.revision,
            "sourceHash": self.source_hash,
            "changed": self.changed,
            "characters": len(self._source_code),
            "editable": self.editable,
        }

    def read_source(self, *, offset: int, length: int) -> FileChunk:
        if offset > len(self._source_code):
            raise WorkspaceEditError("Source offset is outside the Calculation")
        content = self._source_code[offset : offset + length]
        next_offset = offset + len(content)
        return FileChunk(
            path="calculation.js",
            sha256=self.source_hash,
            offset=offset,
            total_characters=len(self._source_code),
            content=content,
            next_offset=next_offset if next_offset < len(self._source_code) else None,
        )

    def write_source(self, content: str, expected_sha256: str) -> dict[str, Any]:
        if not self.editable:
            raise WorkspaceEditError("Calculation source is read-only")
        if not _secure_equal(self.source_hash, expected_sha256):
            raise WorkspaceEditError("Calculation source changed before this write")
        self._source_code = content
        self._source_hash = text_hash(content)
        self.revision += 1
        return {
            "sha256": self.source_hash,
            "stagedRevision": self.revision,
            "sourceHash": self.source_hash,
        }


def require_safe_source_path(path: str) -> None:
    if (
        not path
        or "\\" in path
        or path.startswith("/")
        or posixpath.normpath(path) != path
        or path.startswith("../")
        or any(
            segment in {"", ".", ".."} or SOURCE_SEGMENT_RE.fullmatch(segment) is None
            for segment in path.split("/")
        )
    ):
        raise WorkspaceEditError("Experiment source file path is not allowed")


def bundle_hash(bundle: ExperimentSourceBundle) -> str:
    canonical_bundle = {"files": {path: bundle.files[path] for path in sorted(bundle.files)}}
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
