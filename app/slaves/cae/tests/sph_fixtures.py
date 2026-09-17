"""Small periodic-channel inputs shared by SPH kernels and validation."""

import numpy as np


def channel(rows=12):
    spacing = 1.0 / rows
    shape = (4, rows, 4)
    size = np.array(shape) * spacing
    points = np.stack(np.meshgrid(*[(np.arange(count) + 0.5) * spacing for count in shape], indexing="ij"), axis=-1).reshape(-1, 3)
    settings = {"h": 1.3 * spacing, "origin": np.zeros(3), "size": size, "periodic": np.array([True, False, True]), "density": 1000.0, "viscosity": 100.0, "soundSpeed": 10.0, "exponent": 7.0, "gravity": np.zeros(3)}
    return points, np.full(len(points), settings["density"]), np.full(len(points), settings["density"] * spacing**3), settings
