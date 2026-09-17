"""Exterior and material-interface owners without Python objects per tet face."""

import numpy as np


TET4_FACES = np.array([[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]])


def material_boundary_owners(cells, regions):
    """Return flat cell*4+face owner pairs; -1 denotes an exterior face.

    Interior faces are discarded one material at a time. Output follows the
    first occurrence in the original cells, with the lower region first.
    """
    if not len(cells):
        return np.empty((0, 2), dtype=np.int64)
    exposed = []
    for region in np.unique(regions):
        selected = np.flatnonzero(regions == region)
        keys = np.sort(cells[selected][:, TET4_FACES].reshape(-1, 3), axis=1)
        order = np.lexsort(keys.T[::-1])
        keys = keys[order]
        equal = np.all(keys[1:] == keys[:-1], axis=1)
        if np.any(equal[:-1] & equal[1:]):
            raise ValueError("tetrahedral mesh has a nonmanifold face")
        exterior = ~(np.r_[False, equal] | np.r_[equal, False])
        occurrences = order[exterior]
        exposed.append(selected[occurrences // 4] * 4 + occurrences % 4)
        del keys, order, equal, exterior, occurrences
    occurrences = np.concatenate(exposed)
    keys = np.sort(cells[occurrences[:, None] // 4, TET4_FACES[occurrences % 4]], axis=1)
    order = np.lexsort(keys.T[::-1])
    keys, occurrences = keys[order], occurrences[order]
    equal = np.all(keys[1:] == keys[:-1], axis=1)
    if np.any(equal[:-1] & equal[1:]):
        raise ValueError("tetrahedral mesh has a nonmanifold face")
    starts = np.flatnonzero(np.r_[True, ~equal])
    owners = np.full((len(starts), 2), -1, dtype=np.int64)
    owners[:, 0] = occurrences[starts]
    paired = starts[np.r_[equal, False][starts]]
    owners[np.r_[equal, False][starts], 1] = occurrences[paired + 1]
    first_occurrence = np.where(owners[:, 1] < 0, owners[:, 0], owners.min(axis=1))
    paired_rows = np.flatnonzero(owners[:, 1] >= 0)
    reverse = paired_rows[regions[owners[paired_rows, 0] // 4] > regions[owners[paired_rows, 1] // 4]]
    owners[reverse] = owners[reverse, ::-1]
    return owners[np.argsort(first_occurrence)]
