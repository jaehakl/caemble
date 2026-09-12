from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Any

import numpy as np

from app.methods.structured.models import VoxelDomain
from app.kernel.api import StructuredGridValue
from app.methods.structured.voxel import axis_ticks

def structured_grid_value(
    domain: VoxelDomain,
    *,
    geometry_hashes: Iterable[str],
    root_ids: Iterable[str],
    reference_length_unit: str,
) -> StructuredGridValue:
    """Export the voxel field axes, identity, and geometry provenance together."""
    ticks = axis_ticks(domain)
    signature = {
        "geometryHashes": list(geometry_hashes),
        "rootIds": list(root_ids),
        "referenceLengthUnit": reference_length_unit,
        "shape": [domain.shape[0], domain.shape[2], domain.shape[1]],
        "axis": np.asarray(domain.axis, dtype=np.float64).tolist(),
        "origin": np.asarray(domain.origin, dtype=np.float64).tolist(),
        "length": domain.length,
        "minimumU": domain.minimum_u,
        "minimumV": domain.minimum_v,
        "spacings": [domain.axial_spacing, domain.v_spacing, domain.u_spacing],
    }
    identity = hashlib.sha256(
        json.dumps(signature, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return StructuredGridValue(
        shape=tuple(signature["shape"]),
        axes=tuple(np.asarray(axis, dtype=np.float64) for axis in ticks),
        unit=reference_length_unit,
        identity=identity,
        metadata=signature,
    )
