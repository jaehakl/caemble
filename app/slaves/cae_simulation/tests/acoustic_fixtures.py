"""Small reusable fixtures, independent of pytest test modules."""

from app.solvers.pressure_acoustics.harmonic_fem.boundaries import prepare_boundaries
from app.solvers.pressure_acoustics.harmonic_fem.model import AcousticModel
from itertools import permutations, product
import numpy as np


def tube(divisions):
    nx, ny, nz = divisions
    shape = np.array(divisions) + 1
    points = np.asarray(list(product(np.linspace(0, .5, nx + 1), np.linspace(0, .1, ny + 1), np.linspace(0, .1, nz + 1))))
    cells = []
    for cube in product(range(nx), range(ny), range(nz)):
        for axes in permutations(range(3)):
            coordinates = [np.array(cube)]
            for axis in axes:
                coordinates.append(coordinates[-1] + np.eye(3, dtype=int)[axis])
            cell = np.ravel_multi_index(np.asarray(coordinates).T, shape)
            if np.linalg.det((points[cell[1:]] - points[cell[0]]).T) < 0:
                cell[[1, 2]] = cell[[2, 1]]
            cells.append(cell)
    cells = np.asarray(cells)
    occurrences = {}
    for cell in cells:
        for opposite in range(4):
            face = np.delete(cell, opposite)
            vertices = points[face]
            if np.cross(vertices[1] - vertices[0], vertices[2] - vertices[0]) @ (points[cell[opposite]] - vertices[0]) > 0:
                face[[1, 2]] = face[[2, 1]]
            key = tuple(sorted(face))
            occurrences[key] = None if key in occurrences else face
    faces = np.asarray([face for face in occurrences.values() if face is not None])
    regions = {
        "inlet": {"faces": faces[np.all(points[faces, 0] == 0, axis=1)]},
        "outlet": {"faces": faces[np.all(points[faces, 0] == .5, axis=1)]},
    }
    return AcousticModel(points, cells, regions, 1.2, 343.)


def driven_boundaries(model, frequencies, resistance=None):
    return prepare_boundaries(model, [
        {"methodId": "acoustics.normal-velocity", "target": ["inlet"], "parameters": {"amplitude": 1., "phase": np.pi}},
        {"methodId": "acoustics.impedance", "target": ["outlet"], "parameters": {"resistance": resistance or model.density * model.sound_speed}},
    ], frequencies)
