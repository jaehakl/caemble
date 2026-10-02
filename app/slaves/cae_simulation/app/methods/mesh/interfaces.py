"""Split scalar node traces on explicitly selected conforming tetrahedral faces."""

from dataclasses import replace

import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import connected_components

from app.kernel.api import ContentKey


def split_interface_nodes(domain, cut_faces):
    cells = domain.cells["tet4"]
    local_faces = np.array([[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]])
    faces = cells[:, local_faces].reshape(-1, 3)
    corners = (4 * np.arange(len(cells))[:, None, None] + local_faces).reshape(-1, 3)
    permutations = np.argsort(faces, axis=1)
    sorted_faces = np.take_along_axis(faces, permutations, axis=1)
    corners = np.take_along_axis(corners, permutations, axis=1)
    order = np.lexsort(sorted_faces.T[::-1])
    same = np.all(sorted_faces[order[1:]] == sorted_faces[order[:-1]], axis=1)
    if np.any(same[1:] & same[:-1]):
        raise ValueError("interface splitting requires a manifold tetrahedral mesh")
    first, second = order[:-1][same], order[1:][same]
    cut = {tuple(sorted(face)) for face in cut_faces}
    is_cut = np.asarray([tuple(face) in cut for face in sorted_faces[first]])
    matched = {tuple(face) for face in sorted_faces[first[is_cut]]}
    if matched != cut:
        raise ValueError("thermal interfaces must select paired internal faces of the same assembly")
    rows, columns = corners[first[~is_cut]].ravel(), corners[second[~is_cut]].ravel()
    graph = sparse.csr_matrix((np.ones(len(rows)), (rows, columns)), shape=(4 * len(cells),) * 2)
    _, labels = connected_components(graph, directed=False)
    _, representative = np.unique(labels, return_index=True)
    original_nodes = cells.ravel()[representative]
    thermal_cells = labels.reshape(-1, 4)
    traces = {}
    count = np.bincount(np.r_[first, second], minlength=len(faces))
    selected_faces = np.r_[np.flatnonzero(count == 0), first[is_cut], second[is_cut]]
    for face_index in selected_faces:
        key = tuple(sorted_faces[face_index])
        region = int(domain.metadata["cellRegions"][face_index // 4])
        traces.setdefault(key, []).append((region, labels[corners[face_index]]))
    identity = ContentKey.from_parts("split-interface-mesh-v1", domain.identity, np.asarray(sorted(cut), dtype=np.int64)).digest
    result = replace(domain, points=domain.points[original_nodes], cells={"tet4": thermal_cells}, identity=identity,
        metadata={**domain.metadata, "parentNodeIds": np.asarray(domain.metadata["parentNodeIds"])[original_nodes],
                  "thermalTopologyIdentity": identity})
    return result, traces
