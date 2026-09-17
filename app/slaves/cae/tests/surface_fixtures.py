"""Small reusable fixtures, independent of pytest test modules."""

from itertools import product
import numpy as np


def rectangle(nx, ny, alternate=False):
    points = np.asarray([[x, y, 0.] for y in np.linspace(0, 1, ny + 1) for x in np.linspace(0, 2, nx + 1)])
    faces = []
    for y, x in product(range(ny), range(nx)):
        a = y * (nx + 1) + x
        b, c, d = a + 1, a + nx + 2, a + nx + 1
        faces.extend(([a, b, d], [b, c, d]) if alternate else ([a, b, c], [a, c, d]))
    return points, np.asarray(faces)
