"""Preload-dependent geometric stiffness for buckling."""

import numpy as np
from scipy import sparse

from ..beam import beam_geometric_stiffness
from ..continuum import element_response, geometric_stiffness
from ..shells import shell4_geometric_stiffness, shell4_response


def geometric_matrix(model, displacement, prepared):
    rows, columns, values = [], [], []
    for element, data in zip(model.elements, prepared.element_data):
        dofs = data["dofs"]
        u = displacement.ravel()[dofs]
        points = model.points[element.nodes]
        if element.kind == "beam2":
            transform = np.kron(np.eye(4), data["frame"].T)
            end_force = data["localK"] @ (transform @ u)
            block = transform.T @ beam_geometric_stiffness(data["length"], end_force[6]) @ transform
        elif element.kind == "truss2":
            length = np.linalg.norm(points[1] - points[0])
            direction = (points[1] - points[0]) / length
            tension = element.material["E"] * element.section["area"] / length * direction @ (u[3:] - u[:3])
            tensor = tension / length * (np.eye(3) - np.outer(direction, direction))
            block = np.block([[tensor, -tensor], [-tensor, tensor]])
        elif element.kind == "shell4":
            response = shell4_response(points, u, element.section)
            block = shell4_geometric_stiffness(points, response["force"])
        else:
            coords = points[:, :2] if element.kind in ("tri3", "quad4") else points
            stress = element_response(element.kind, coords, u, element.material["C"], element.section.get("thickness", 1), element.section.get("plane", "stress"))[1]
            block = geometric_stiffness(element.kind, coords, stress, element.section.get("thickness", 1), element.section.get("plane", "stress"))
        rows.extend(np.repeat(dofs, len(dofs)))
        columns.extend(np.tile(dofs, len(dofs)))
        values.extend(block.ravel())
    return sparse.csr_matrix((values, (rows, columns)), shape=(model.size, model.size))
