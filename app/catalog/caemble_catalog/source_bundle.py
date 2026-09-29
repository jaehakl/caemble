"""Writable Experiment source path contract; historical bundles remain readable."""

import re
from collections.abc import Mapping

_SOURCE_PATH = re.compile(
    r"(?:experiment\.tsx|geometry\.tsx|material\.tsx|simulate\.py|tasks/[A-Za-z][A-Za-z0-9_-]*\.tsx)"
)
_ALLOWED = "experiment.tsx, geometry.tsx, material.tsx, simulate.py, tasks/<name>.tsx (name: [A-Za-z][A-Za-z0-9_-]*)"


def validate_experiment_source_bundle(bundle: Mapping) -> None:
    if not isinstance(bundle, Mapping):
        raise ValueError("Experiment source bundle must contain a files mapping.")
    files = bundle.get("files")
    if not isinstance(files, Mapping):
        raise ValueError("Experiment source bundle must contain a files mapping.")
    folded = {}
    for path in files:
        if not isinstance(path, str) or _SOURCE_PATH.fullmatch(path) is None:
            raise ValueError(f"Experiment source path is not allowed: {path}. Allowed: {_ALLOWED}.")
        existing = folded.get(path.lower())
        if existing is not None and existing != path:
            raise ValueError(f"Experiment source paths differ only by case: {existing}, {path}. Allowed: {_ALLOWED}.")
        folded[path.lower()] = path
