"""Resolve actual oriented boundary faces from canonical semantic provenance."""

import numpy as np


def select_boundary_region(points, faces, aliases, selectors):
    """Return the selected semantic side; bonded aliases reverse first-side winding."""
    selectors = set(selectors)
    indices = [index for index, provenance in enumerate(aliases) if selectors.intersection(provenance)]
    selected_faces = np.asarray([
        faces[index] if side == 0 else faces[index, [0, 2, 1]]
        for index in indices for side, alias in enumerate(aliases[index])
        if alias in selectors
    ], dtype=int).reshape(-1, 3)
    if not len(selected_faces):
        return None
    triangles = np.asarray(points)[selected_faces]
    cross = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    area = np.linalg.norm(cross, axis=1) / 2
    if np.any(area <= 0):
        raise ValueError("selected boundary contains a degenerate triangle")
    nodes, inverse = np.unique(selected_faces.ravel(), return_inverse=True)
    weights = np.zeros(len(nodes))
    np.add.at(weights, inverse, np.repeat(area / 3, 3))
    roots = sorted({alias[1] for index in indices for alias in selectors.intersection(aliases[index])})
    return {
        "faces": selected_faces, "nodes": nodes, "weights": weights / area.sum(),
        "area": float(area.sum()), "rootId": roots[0], "rootIds": roots,
        "referencePoint": np.average(triangles.mean(axis=1), weights=area, axis=0),
        "faceNormals": cross / (2 * area[:, None]), "faceAreas": area,
    }
