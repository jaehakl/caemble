"""Explicit material-pair interface laws and their two-sided scalar FEM assembly."""

from dataclasses import replace

import numpy as np
from scipy import sparse

from app.kernel.api.world import interaction_model, scalar_parameter
from app.methods.finite_element.scalar import ScalarElements
from app.methods.mesh.interfaces import split_interface_nodes


def prepare_interfaces(invocation, mesh, parts):
    scene = invocation.world["experiment"]
    contacts = []
    used = set()
    for rule in invocation.config["boundaryConditions"]:
        if rule["methodId"] != "heat.interface":
            continue
        if len(rule["target"]) != 2:
            raise ValueError("a thermal interface requires exactly two surface groups")
        sides = []
        for target in rule["target"]:
            selectors = next(group["selectors"] for group in scene["surfaceGroups"] if group["name"] == target.split(".", 2)[2])
            roots = {selector["rootId"] for selector in selectors}
            if len(roots) != 1 or not roots.issubset(parts):
                raise ValueError("each thermal interface side must belong to one active material region")
            faces = mesh.surface_faces(selectors, exterior=False)
            sides.append((next(iter(roots)), {tuple(sorted(face)) for face in faces}))
        if sides[0][0] == sides[1][0] or sides[0][1] != sides[1][1] or not sides[0][1]:
            raise ValueError("thermal interface sides must be exactly matching faces of different regions")
        if used & sides[0][1]:
            raise ValueError("thermal interface rules must not overlap")
        used.update(sides[0][1])
        model = interaction_model(invocation.world, parts[sides[0][0]], parts[sides[1][0]], "thermalInterface", "conductance")
        if model is None or model["model"] != "heat.constant-interface-conductance@1":
            raise ValueError("selected thermal interface requires an explicit conductance Interaction")
        conductance = scalar_parameter(model["parameters"]["coefficient"])
        if not np.isfinite(conductance) or conductance <= 0:
            raise ValueError("interface conductance must be positive and finite")
        contacts.append((sides, conductance))
    if not contacts:
        return mesh, (), None
    domain, traces = split_interface_nodes(mesh.field_domain, used)
    result = []
    for sides, conductance in contacts:
        first_region, second_region = (mesh.assembly.region_ids.index(side[0]) for side in sides)
        first, second = [], []
        for face in sorted(sides[0][1]):
            paired = dict(traces[face])
            if set(paired) != {first_region, second_region}:
                raise ValueError("interface faces do not match the declared material regions")
            first.append(paired[first_region])
            second.append(paired[second_region])
        result.append((np.asarray(first), np.asarray(second), conductance))
    return replace(mesh, field_domain=domain, elements=ScalarElements.prepare(domain.points, domain.cells["tet4"])), tuple(result), traces


def interface_matrix(points, interfaces):
    matrix = sparse.csr_matrix((len(points), len(points)))
    for first, second, coefficient in interfaces:
        vertices = points[first]
        areas = np.linalg.norm(np.cross(vertices[:, 1] - vertices[:, 0], vertices[:, 2] - vertices[:, 0]), axis=1) / 2
        entries = coefficient * areas[:, None, None] * (np.ones((3, 3)) + np.eye(3)) / 12
        nodes = np.concatenate((first, second), axis=1)
        blocks = np.concatenate((np.concatenate((entries, -entries), axis=2),
                                 np.concatenate((-entries, entries), axis=2)), axis=1)
        matrix += sparse.csr_matrix((blocks.ravel(), (np.repeat(nodes, 6, axis=1).ravel(),
            np.tile(nodes, (1, 6)).ravel())), shape=matrix.shape)
    return matrix
