"""Small numerical fixtures shared by function and entry checks."""
import numpy as np
from app.solvers.structural_mechanics.model import Element, StructuralModel


POINTS = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]])


MATERIAL = {"model": "mechanics.compressible-neo-hookean@1", "density": 1., "shear": 80., "lame": 110.}


def stretch_model(stretch=.8, lame=110.):
    material = {**MATERIAL, "lame": lame}
    fixed = np.array([0, 1, 2, 6, 7, 8, 12, 14, 18, 19])
    model = StructuralModel(np.arange(4), POINTS.copy(), [Element("tet4", np.arange(4), material)],
                            (6*np.arange(4)[:, None]+np.arange(3)).ravel(), fixed, np.zeros((4, 6)))
    model.prescribed = {int(dof): 0. for dof in fixed}
    model.prescribed[6] = stretch-1
    model.solid_formulation = "mixed-mini"
    model.identity = "mini-test-solid"
    return model
