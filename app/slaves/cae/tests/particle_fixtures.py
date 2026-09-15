"""Explicit identities used by resource-boundary particle fixtures."""

import numpy as np


def particle_identity(count=2):
    return {
        "particle_ids": np.arange(count, dtype=np.int64),
        "material_indices": np.zeros(count, dtype=np.int32),
        "materials": ({"source": "experiment", "task": None, "name": "fixture", "definition": {}},),
    }
