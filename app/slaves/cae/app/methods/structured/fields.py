from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

import numpy as np

from app.methods.structured.models import VoxelDomain
from app.methods.structured.voxel import axis_ticks

STRUCTURED_GRID_KIND = "caemble.structured-grid/v1"
STRUCTURED_FIELD_KIND = "caemble.structured-field/v1"


def structured_grid_ref(
    domain: VoxelDomain,
    *,
    geometry_hashes: Iterable[str],
    root_ids: Iterable[str],
    reference_length_unit: str,
) -> dict[str, Any]:
    ticks = axis_ticks(domain)
    signature = {
        "geometryHashes": list(geometry_hashes),
        "rootIds": list(root_ids),
        "referenceLengthUnit": reference_length_unit,
        "shape": [domain.shape[0], domain.shape[2], domain.shape[1]],
        "axis": np.asarray(domain.axis, dtype=np.float64).tolist(),
        "length": domain.length,
        "minimumU": domain.minimum_u,
        "minimumV": domain.minimum_v,
        "spacings": [domain.axial_spacing, domain.v_spacing, domain.u_spacing],
    }
    identity = hashlib.sha256(
        json.dumps(signature, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {
        "kind": STRUCTURED_GRID_KIND,
        "id": identity,
        **signature,
        "axes": [
            {"ticks": list(ticks[0]), "spacing": domain.axial_spacing},
            {"ticks": list(ticks[1]), "spacing": domain.v_spacing},
            {"ticks": list(ticks[2]), "spacing": domain.u_spacing},
        ],
    }


def structured_cell_field(
    domain_ref: Mapping[str, Any],
    value: np.ndarray[Any, Any],
    axes: Sequence[Mapping[str, Any]],
    *,
    quantity_kind: str | None,
    unit: str | None,
) -> dict[str, Any]:
    return {
        "kind": STRUCTURED_FIELD_KIND,
        "domainRef": dict(domain_ref),
        "location": "cell",
        "quantityKind": quantity_kind,
        "unit": unit,
        "value": value,
        "axes": [dict(axis) for axis in axes],
    }


def is_structured_cell_field(value: Any) -> bool:
    return (
        isinstance(value, Mapping)
        and value.get("kind") == STRUCTURED_FIELD_KIND
        and value.get("location") == "cell"
        and isinstance(value.get("domainRef"), Mapping)
    )

