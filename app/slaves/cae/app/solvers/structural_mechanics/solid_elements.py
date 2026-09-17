"""Array storage for the linear thermal solid, with ordinary element access."""

from collections.abc import Sequence
from types import SimpleNamespace

import numpy as np

from .model import Element


class SolidElements(Sequence):
    def __init__(self, cells, material_indices, materials, root_ids):
        self.cells = cells
        self.material_indices = material_indices
        self.materials = materials
        self.root_ids = root_ids

    def __len__(self):
        return len(self.cells)

    def __getitem__(self, index):
        if isinstance(index, slice):
            return [self[item] for item in range(*index.indices(len(self)))]
        material = self.material_indices[index]
        return Element("tet4", self.cells[index], self.materials[material], {}, self.root_ids[material])

    def update_material_fingerprint(self, fingerprint, encode):
        """Stream exactly the previous list encoding, reusing material bytes."""
        fragments = []
        for material, root_id in zip(self.materials, self.root_ids, strict=True):
            payload = bytearray()
            encode(SimpleNamespace(update=payload.extend), (material, root_id))
            fragments.append(bytes(payload))
        fingerprint.update(b"sequence" + len(self).to_bytes(8, "little"))
        starts = np.r_[0, np.flatnonzero(np.diff(self.material_indices)) + 1, len(self)]
        for start, stop in zip(starts, starts[1:]):
            if start == stop:
                continue
            fragment = fragments[self.material_indices[start]]
            for offset in range(start, stop, 4096):
                fingerprint.update(fragment * min(4096, stop - offset))
