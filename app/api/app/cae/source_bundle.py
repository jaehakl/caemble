"""Validation at write/run boundaries, without restricting historical reads."""

from fastapi import HTTPException
from caemble_catalog.source_bundle import validate_experiment_source_bundle


def require_experiment_source_bundle(bundle: dict) -> None:
    try:
        validate_experiment_source_bundle(bundle)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
