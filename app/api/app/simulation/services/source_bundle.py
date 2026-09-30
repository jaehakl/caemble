"""Validation at write/run boundaries, without restricting historical reads."""

import hashlib
import json
from typing import Any

from fastapi import HTTPException
from caemble_catalog.source_bundle import validate_experiment_source_bundle


def require_experiment_source_bundle(bundle: dict) -> None:
    try:
        validate_experiment_source_bundle(bundle)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


def bundle_hash(bundle: dict[str, Any]) -> str:
    canonical = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
