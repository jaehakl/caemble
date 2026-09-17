"""Small reusable fixtures, independent of pytest test modules."""

from app.kernel.api import ContentKey
from app.methods.fields.box_grid import BoxGrid
from app.methods.finite_volume.tetrahedral import create_fv_mesh
from app.methods.geometry import GeometryService
from app.solvers.incompressible_flow.periodic import apply_periodic
from itertools import combinations, permutations
from types import SimpleNamespace
import numpy as np


def tetrahedral_box(shape=(3, 3, 3), size=(1., 1., 1.), *, irregular=True):
    shape, size = np.asarray(shape), np.asarray(size)
    coordinates = np.asarray(list(np.ndindex(tuple(shape + 1))), dtype=float) / shape
    if irregular:
        amplitude = np.prod(np.sin(np.pi * coordinates), axis=1)
        coordinates += amplitude[:, None] * np.array([.17, -.13, .11]) / shape
    points = coordinates * size
    indices = np.arange(len(points)).reshape(tuple(shape + 1))
    cells = []
    for origin in np.ndindex(tuple(shape)):
        for ordering in permutations(range(3)):
            current = np.array(origin)
            cell = [indices[tuple(current)]]
            for axis in ordering:
                current[axis] += 1
                cell.append(indices[tuple(current)])
            cells.append(cell)
    faces = {}
    for cell in cells:
        for face in combinations(cell, 3):
            key = tuple(sorted(face))
            faces[key] = faces.get(key, 0) + 1
    boundary = np.asarray([face for face, count in faces.items() if count == 1])
    return create_fv_mesh(points, np.asarray(cells), boundary)


def pressure_duct_boundaries(mesh, pressure_drop=1.):
    boundary = mesh.neighbour < 0
    lower, upper = mesh.points[:, 0].min(), mesh.points[:, 0].max()
    inlet = boundary & np.isclose(mesh.face_centers[:, 0], lower)
    outlet = boundary & np.isclose(mesh.face_centers[:, 0], upper)
    velocity = np.full((len(mesh.faces), 3), np.nan)
    pressure = np.full(len(mesh.faces), np.nan)
    velocity[boundary & ~inlet & ~outlet] = 0
    pressure[inlet], pressure[outlet] = pressure_drop, 0
    return velocity, pressure, inlet, outlet


def fluid_invocation(*, boolean=None, length_unit="m"):
    outer = {"kind": "primitive", "nodeId": "outer", "primitive": "box", "parameters": {"size": [1., 1., 1.]}}
    node = outer
    if boolean == "hole":
        node = {"kind": "boolean", "nodeId": "cut", "operation": "subtract", "children": [outer,
            {"kind": "primitive", "nodeId": "hole", "primitive": "box", "parameters": {"size": [.2, .2, 1.2]}}]}
    elif boolean == "disconnected":
        node = {"kind": "boolean", "nodeId": "cut", "operation": "subtract", "children": [outer,
            {"kind": "primitive", "nodeId": "gap", "primitive": "box", "parameters": {"size": [.2, 1.2, 1.2]}}]}
    scene = {"geometryHash": str(ContentKey.from_parts("flow-domain-test", node, length_unit)), "lengthUnit": length_unit,
        "roots": [{"id": "fluid", "node": node, "material": {"name": "fluid"}}],
        "geometryGroups": [{"name": "fluid", "rootIds": ["fluid"]}],
        "surfaceGroups": [{"name": "ends", "selectors": [
            {"rootId": "fluid", "sourceNodeId": "outer", "surfaceIndex": side} for side in [0, 1]]}]}
    world = {"experiment": scene,
        "materials": {"experiment": {"fluid": {"models": {"newtonian": {
            "model": "fluidDynamics.newtonian-fluid@1", "parameters": {"density": 1000., "dynamicViscosity": 1.}}}}}},
        "materialSelections": {"fluidDomain": {"fluid": {"constitutive": "newtonian"}}}}
    return SimpleNamespace(world=world, geometry=GeometryService(), progress=None, cancellation=None,
        config={"parameters": {"spatialResolution": .3 if length_unit == "m" else .0003},
            "initializations": [{"methodId": "flow.fluid", "target": ["experiment.geometry.fluid"]}],
            "boundaryConditions": []})


def observation(shape=(2, 2, 2), origin=(0, 0, 0), size=(1, 1, 1), rotation=None, unit="m"):
    return BoxGrid({"origin": list(origin), "size": list(size), "gridShape": list(shape),
                    "rotation": np.eye(3) if rotation is None else rotation,
                    "lengthUnit": unit, "source": "experiment", "rootId": "probe"})


def periodic_box(shape=(4, 3, 3), axes=(0, 1), *, nonmatching=True):
    base = tetrahedral_box(shape, (2., 1., 1.))
    if nonmatching:
        points = base.points.copy()
        normalized = points / [2., 1., 1.]
        selected = np.isclose(normalized[:, 0], 1)
        amplitude = np.sin(np.pi*normalized[:, 1]) * np.sin(np.pi*normalized[:, 2])
        points[selected, 1] += .13/shape[1] * amplitude[selected]
        points[selected, 2] -= .11/shape[2] * amplitude[selected]
        base = create_fv_mesh(points, base.cells, base.faces[base.boundary_face_map])
    pairs = []
    for axis in axes:
        lower, upper = base.points[:, axis].min(), base.points[:, axis].max()
        exterior = base.neighbour < 0
        source = np.flatnonzero(exterior & np.isclose(base.face_centers[:, axis], lower))
        target = np.flatnonzero(exterior & np.isclose(base.face_centers[:, axis], upper))
        translation = np.zeros(3)
        translation[axis] = upper-lower
        pairs.append({"sourceFaces": source, "targetFaces": target, "translation": translation})
    return base, pairs, apply_periodic(base, pairs)


def closed_boundaries(mesh):
    velocity = np.full((mesh.face_count, 3), np.nan)
    velocity[mesh.neighbour < 0] = 0
    return velocity, np.full(mesh.face_count, np.nan)
