"""Small numerical fixtures shared by function and entry checks."""
import numpy as np


POINTS = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]])


MATERIAL = {"model": "mechanics.compressible-neo-hookean@1", "density": 1000., "shear": 80., "lame": 110.}
