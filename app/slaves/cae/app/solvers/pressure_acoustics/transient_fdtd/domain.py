"""Exact Box geometry, physical boundary faces and homogeneous fluid values."""

import hashlib
import json
from dataclasses import dataclass

import numpy as np

from app.kernel.api.units import convert_ucum_value
from app.kernel.api.world import geometry_parts, material_model

from ..parameters import parameter


@dataclass(frozen=True)
class CartesianAcousticGrid:
    origin: np.ndarray
    size: np.ndarray
    shape: tuple
    density: float
    sound_speed: float
    boundary_regions: dict
    identity: str = "cartesian-acoustic-grid"

    @property
    def spacing(self):
        return self.size / self.shape

    @property
    def axes(self):
        return tuple(self.origin[j] + (np.arange(n) + .5) * self.spacing[j]
                     for j, n in enumerate(self.shape))

    @property
    def bounds(self):
        return np.column_stack((self.origin, self.origin + self.size))

    def face_mesh(self, axis, side):
        """Return outward-wound quads ordered like the corresponding velocity slice."""
        tangents = [j for j in range(3) if j != axis]
        coordinates = [self.origin[j] + np.arange(self.shape[j] + 1) * self.spacing[j]
                       for j in tangents]
        plane = np.stack(np.meshgrid(*coordinates, indexing="ij"), axis=-1)
        points = np.zeros((*plane.shape[:2], 3))
        points[..., axis] = self.origin[axis] + side * self.size[axis]
        points[..., tangents] = plane
        indices = np.arange(np.prod(plane.shape[:2])).reshape(plane.shape[:2])
        quads = np.stack((indices[:-1, :-1], indices[1:, :-1], indices[1:, 1:], indices[:-1, 1:]), axis=-1).reshape(-1, 4)
        points = points.reshape(-1, 3)
        normal = np.cross(points[quads[0, 1]] - points[quads[0, 0]], points[quads[0, 2]] - points[quads[0, 0]])
        if normal[axis] * (2 * side - 1) < 0:
            quads = quads[:, ::-1]
        return points, quads


async def build_grid(invocation):
    rules = [r for r in invocation.config["initializations"] if r["methodId"] == "acoustics.fluid"]
    if len(rules) != 1 or len(rules[0]["target"]) != 1:
        raise ValueError("transient acoustics requires one homogeneous fluid geometry target")
    source, _, group = rules[0]["target"][0].split(".", 2)
    scene = invocation.world[source]
    parts = geometry_parts(scene, group)
    if len(parts) != 1:
        raise ValueError("transient acoustics requires one axis-aligned Box root")
    part = parts[0]
    node, transform = part["node"], np.eye(4)
    while node["kind"] in ("transform", "instance"):
        transform = transform @ np.asarray(node["matrix"], float).reshape(4, 4)
        node = node["child"]
    if node["kind"] != "primitive" or node["primitive"] != "box":
        raise ValueError("transient acoustics supports an axis-aligned Box primitive, without Boolean or curved approximations")
    edges = transform[:3, :3] * np.asarray(node["parameters"]["size"], float)
    lengths = np.linalg.norm(edges, axis=0)
    if np.any(lengths <= 0) or not np.all(np.isfinite(edges)):
        raise ValueError("transient acoustics requires finite positive Box lengths")
    directions = edges / lengths
    world_axes = np.argmax(np.abs(directions), axis=0)
    aligned = np.zeros((3, 3))
    aligned[world_axes, np.arange(3)] = np.sign(directions[world_axes, np.arange(3)])
    if (not np.allclose(directions @ directions.T, np.eye(3), atol=1e-10, rtol=0)
            or not np.allclose(directions, aligned, atol=1e-10, rtol=0)):
        raise ValueError("transient acoustics requires a world-axis-aligned Box; oblique or sheared grids are unsupported")
    scale = convert_ucum_value(1, scene["lengthUnit"], "m")
    # Recover lengths from transformed primitive edges, not translated corners:
    # subtracting corner coordinates can round an exact L/h above an integer.
    # The alignment check above also excludes two edges sharing a world axis.
    size = np.empty(3)
    size[world_axes] = lengths * scale
    origin = transform[:3, 3] * scale - size / 2
    resolution = float(parameter(invocation.config["parameters"]["spatialResolution"]))
    if not np.isfinite(resolution) or resolution <= 0:
        raise ValueError("acoustic spatialResolution must be finite and positive")
    shape = tuple(np.ceil(size / resolution).astype(int))
    material = material_model(invocation.world, part, "fluidDomain", "constitutive", source)
    if material is None or material["model"] != "acoustics.homogeneous-fluid@1":
        raise ValueError("fluidDomain requires acoustics.homogeneous-fluid@1")
    density = float(parameter(material["parameters"]["density"]))
    sound_speed = float(parameter(material["parameters"]["soundSpeed"]))
    if not np.isfinite(density + sound_speed) or min(density, sound_speed) <= 0:
        raise ValueError("fluid density and sound speed must be finite and positive")
    mesh = await invocation.geometry.triangular_mesh(scene, part["id"], "m", progress=invocation.progress)
    triangles = mesh.vertices[mesh.triangles]
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    regions = {}
    for group in scene["surfaceGroups"]:
        selected = set()
        for selector in group["selectors"]:
            for index in mesh.triangle_indices(selector):
                axis = int(np.argmax(np.abs(normals[index])))
                selected.add((axis, int(normals[index, axis] > 0)))
        if selected:
            regions[f"{source}.surface.{group['name']}"] = selected
    identity_data = [source, part["id"], origin.tolist(), size.tolist(), list(map(int, shape)), density, sound_speed]
    identity = hashlib.sha256(json.dumps(identity_data, separators=(",", ":")).encode()).hexdigest()
    return CartesianAcousticGrid(origin, size, shape, density, sound_speed, regions, identity)
