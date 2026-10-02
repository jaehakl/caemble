"""Current-surface pressure forces and their exact displacement derivative."""

import numpy as np
from scipy import sparse


def follower_pressure(model, displacement, *, tangent=True):
    force = np.zeros(model.size)
    rows, columns, entries = [], [], []
    points = model.points + displacement[:, :3]
    for faces, pressure in model.follower_pressures:
        triangles = points[faces]
        first, second = triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]
        nodal = -pressure / 6 * np.cross(first, second)
        dofs = (6 * faces[..., None] + np.arange(3)).reshape(-1, 9)
        np.add.at(force, dofs.ravel(), np.tile(nodal, (1, 3)).ravel())
        if tangent:
            derivative = np.zeros((len(faces), 3, 9))
            for component in range(3):
                direction = np.eye(3)[component]
                derivative[:, :, 3 + component] = -pressure / 6 * np.cross(direction, second)
                derivative[:, :, 6 + component] = -pressure / 6 * np.cross(first, direction)
                derivative[:, :, component] = -derivative[:, :, 3 + component] - derivative[:, :, 6 + component]
            rows.extend(np.repeat(dofs, 9, axis=1).ravel())
            columns.extend(np.tile(dofs, (1, 9)).ravel())
            entries.extend(np.tile(derivative, (1, 3, 1)).ravel())
    return force, sparse.csr_matrix((entries, (rows, columns)), shape=(model.size, model.size))


def update_follower_display(model, displacement):
    """Keep the final pressure arrows at actual current face centroids."""
    if not model.follower_pressures:
        return
    points, vectors = [], []
    current = model.points + displacement[:, :3]
    for faces, pressure in model.follower_pressures:
        triangles = current[faces]
        points.extend(triangles.mean(axis=1))
        vectors.extend(-pressure / 2 * np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]))
    model.provenance["loadPoints"] = np.concatenate((np.asarray(model.provenance.get("loadPoints", [])).reshape(-1, 3), points))
    model.provenance["loadVectors"] = np.concatenate((np.asarray(model.provenance.get("loadVectors", [])).reshape(-1, 3), vectors))
