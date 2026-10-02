"""Passive boundary flux observations and independently usable wall traction."""

from dataclasses import dataclass

import numpy as np

from app.kernel.api import ContentKey, FieldValue, UnstructuredMeshValue
from app.methods.coupling.polygons import polygon_area_centroid
from app.methods.fields.box_grid import clip_box_polygon
from app.methods.finite_volume.tetrahedral import cell_operators

from .domain import parameter


def select_surfaces(domain, targets, *, walls_only=False):
    selected = []
    if not targets:
        raise ValueError("flow surface selection requires at least one surface target")
    for target in targets:
        indices = domain.surface_regions.get(target)
        if indices is None or not len(indices):
            raise ValueError(f"flow surface target {target!r} has no selected fluid boundary")
        selected.extend(indices)
    indices = np.unique(np.asarray(selected, dtype=np.int64))
    if walls_only:
        invalid = indices[np.asarray(domain.boundary_roles)[indices] != "wall"]
        if len(invalid):
            face = domain.mesh.boundary_face_map[invalid[0]]
            raise ValueError("flow solid load requires actual no-slip wall surfaces; "
                             f"boundary {invalid[0]}, position {domain.mesh.physical_face_centers[face].tolist()}")
    return indices


def surface_observers(invocation, domain):
    observers = {}
    for rule in invocation.config.get("initializations", []):
        if rule["methodId"] != "flow.observe-surface":
            continue
        name = parameter(rule.get("parameters", {}).get("name"))
        if not isinstance(name, str) or not name.strip() or name in observers:
            raise ValueError("flow surface observations require unique nonempty names")
        targets = list(rule["target"])
        observers[name] = (targets, select_surfaces(domain, targets))
    return observers


def result_metadata(domain, data, *, targets=(), pressure_offset=0., contribution="total", moment_origin=None):
    """Only declared result metadata enters the frozen numerical record channel."""
    if not data.get("metadata"):
        return {}
    values = {
        "pressureKind": "gauge", "pressureReference": domain.metadata["pressureReference"],
        "pressureReferencePoint": np.asarray(domain.metadata["pressureReferencePoint"]).tolist(),
        "hydrostaticGravity": np.asarray(domain.metadata["hydrostaticGravity"]).tolist(),
        "drivingAcceleration": np.asarray(domain.metadata["drivingAcceleration"]).tolist(),
        "coordinateFrame": "world", "surfaceTargets": list(targets),
        "normalConvention": "outward-fluid", "pressureOffset": float(pressure_offset),
        "contribution": contribution, "actionTarget": "fluid-on-solid",
    }
    if moment_origin is not None:
        values["momentOrigin"] = np.asarray(moment_origin, dtype=float).tolist()
    return {name: values[name] for name in data.get("metadata", {})}


def load_settings(parameters, *, moment=False):
    offset = float(parameter(parameters.get("pressureOffset", 0.)))
    contribution = parameter(parameters.get("contribution", "total"))
    if not np.isfinite(offset) or contribution not in {"total", "pressure", "viscous"}:
        raise ValueError("flow loads require a finite pressureOffset and total, pressure or viscous contribution")
    origin = None
    if moment:
        origin = np.asarray(parameter(parameters.get("momentOrigin")), dtype=float)
        if origin.shape != (3,) or not np.all(np.isfinite(origin)):
            raise ValueError("flow momentOrigin must be a finite world Cartesian point in metres")
    return offset, contribution, origin


@dataclass(frozen=True)
class BoundaryTrace:
    pressure: np.ndarray
    pressure_traction: np.ndarray
    viscous_traction: np.ndarray
    normals: np.ndarray

    def traction(self, offset=0., contribution="total"):
        pressure = self.pressure_traction + offset * self.normals
        if contribution == "pressure":
            return pressure
        if contribution == "viscous":
            return self.viscous_traction
        return pressure + self.viscous_traction


class SurfaceRecovery:
    """Recover the boundary traces from the same affine operators as momentum.

    Each physical wall triangle carries one constant, reconstructed cell-average
    traction. Exact geometric clipping integrates that representation, not a
    higher-order continuous stress distribution.
    """

    def __init__(self, domain):
        self.domain, self.mesh = domain, domain.mesh
        mesh = self.mesh
        exterior = mesh.neighbour < 0
        self.velocity_fixed = exterior & np.all(np.isfinite(domain.boundary_velocity), axis=1)
        self.pressure_fixed = exterior & np.isfinite(domain.boundary_pressure)
        self.velocity_operators = cell_operators(mesh, self.velocity_fixed)
        self.pressure_operators = cell_operators(mesh, self.pressure_fixed)
        self.velocity_values = np.where(self.velocity_fixed[:, None], domain.boundary_velocity, 0.)
        reference = np.asarray(domain.metadata["pressureReferencePoint"])
        gravity = np.asarray(domain.metadata["hydrostaticGravity"])
        self.hydrostatic = domain.density * ((mesh.cell_centers - reference) @ gravity)
        self.face_hydrostatic = domain.density * ((mesh.face_centers - reference) @ gravity)
        self.pressure_values = np.where(self.pressure_fixed, domain.boundary_pressure - self.face_hydrostatic, 0.)
        self.areas = np.linalg.norm(mesh.area_vectors, axis=1)
        self.normals = mesh.area_vectors / self.areas[:, None]
        physical = mesh.boundary_face_map
        areas = mesh.physical_area_vectors[physical]
        self.boundary_normals = areas / np.linalg.norm(areas, axis=1)[:, None]
        # A real wall has exactly one exterior interface. Periodic boundary
        # triangles can have several patches; they never carry a solid load.
        self.wall_boundaries = np.flatnonzero(np.asarray(domain.boundary_roles) == "wall")
        patches = domain.boundary_patches
        lookup = {int(boundary): int(interface) for boundary, interface in
                  zip(patches["boundaryIndices"], patches["interfaceIndices"], strict=True)
                  if domain.boundary_roles[int(boundary)] == "wall"}
        self.wall_interfaces = np.asarray([lookup[int(boundary)] for boundary in self.wall_boundaries], dtype=int)

    def trace(self, pressure, velocity):
        mesh, operators = self.mesh, self.velocity_operators
        pressure = np.asarray(pressure) - self.hydrostatic
        face_pressure = (self.pressure_operators.face_value @ pressure
                         + self.pressure_operators.face_value_boundary @ self.pressure_values + self.face_hydrostatic)
        gradient = (operators.gradient @ velocity + operators.gradient_boundary @ self.velocity_values).reshape(-1, 3, 3)
        # derivative-coordinate is the first matrix axis here; the symmetric
        # sum has the conventional stress orientation in either representation.
        normal_derivative = (operators.normal_gradient @ velocity
                             + operators.normal_gradient_boundary @ self.velocity_values) / self.areas[:, None]
        boundary_count = len(mesh.boundary_face_map)
        pressure_traction, viscous_traction = np.zeros((boundary_count, 3)), np.zeros((boundary_count, 3))
        for boundary, face in zip(self.wall_boundaries, self.wall_interfaces, strict=True):
            normal = self.normals[face]
            trace_gradient = gradient[mesh.owner[face]].copy()
            trace_gradient += np.outer(normal, normal_derivative[face] - normal @ trace_gradient)
            # The fixed, constant wall velocity has zero tangential derivative.
            trace_gradient = np.outer(normal, normal @ trace_gradient)
            stress = self.domain.viscosity * (trace_gradient + trace_gradient.T)
            pressure_traction[boundary] = face_pressure[face] * normal
            viscous_traction[boundary] = -stress @ normal
        return BoundaryTrace(face_pressure, pressure_traction, viscous_traction, self.boundary_normals)


@dataclass(frozen=True)
class SurfaceBoxOverlap:
    interfaces: np.ndarray
    boundaries: np.ndarray
    signs: np.ndarray
    areas: np.ndarray
    centroids: np.ndarray
    flux_fractions: np.ndarray

    @classmethod
    def prepare(cls, domain, boundaries, grid, cancellation=None):
        patches = domain.boundary_patches
        selected = np.flatnonzero(np.isin(patches["boundaryIndices"], boundaries))
        interfaces, indices, signs, areas, centroids, fractions = [], [], [], [], [], []
        for patch in selected:
            if cancellation is not None:
                cancellation.raise_if_cancelled()
            first, last = patches["offsets"][patch:patch + 2]
            polygon = patches["vertices"][first:last]
            clipped = clip_box_polygon(polygon, grid)
            area, centroid = polygon_area_centroid(clipped)
            if area <= 0:
                continue
            interface = int(patches["interfaceIndices"][patch])
            interfaces.append(interface)
            indices.append(patches["boundaryIndices"][patch])
            signs.append(patches["signs"][patch])
            areas.append(area)
            centroids.append(centroid)
            fractions.append(area / np.linalg.norm(domain.mesh.area_vectors[interface]))
        return cls(np.asarray(interfaces, dtype=int), np.asarray(indices, dtype=int),
                   np.asarray(signs), np.asarray(areas), np.asarray(centroids).reshape(-1, 3), np.asarray(fractions))

    def volume_flow(self, boundary_flux, interface_order):
        positions = np.searchsorted(interface_order, self.interfaces)
        return float(np.sum(np.asarray(boundary_flux)[positions] * self.signs * self.flux_fractions))

    def average_pressure(self, trace):
        area = float(self.areas.sum())
        return float(self.areas @ trace.pressure[self.interfaces] / area) if area else 0.

    def force_moment(self, trace, offset, contribution, origin=None):
        forces = self.areas[:, None] * trace.traction(offset, contribution)[self.boundaries]
        if origin is not None:
            return np.cross(self.centroids - origin, forces).sum(axis=0)
        return forces.sum(axis=0)


def traction_field(domain, trace, boundaries, data, *, time, targets=(), offset=0., contribution="total"):
    triangles = domain.mesh.faces[domain.mesh.boundary_face_map[boundaries]]
    nodes, connectivity = np.unique(triangles.ravel(), return_inverse=True)
    cells = connectivity.reshape(-1, 3).astype(np.int32)
    source = domain.metadata["boundaryProvenance"]
    alias_indices, offsets = [], [0]
    for boundary in boundaries:
        first, last = source["offsets"][boundary:boundary + 2]
        alias_indices.extend(range(int(first), int(last)))
        offsets.append(len(alias_indices))
    aliases = np.asarray(alias_indices, dtype=int)
    provenance = {name: np.asarray(values)[aliases] for name, values in source.items() if name != "offsets"}
    provenance["offsets"] = np.asarray(offsets, dtype=np.int32)
    metadata = {"sourceModelIdentity": domain.identity, "sourceMeshNodeIds": nodes.astype(np.int32),
                "boundaryProvenance": provenance}
    mesh = UnstructuredMeshValue(domain.mesh.points[nodes], {"tri3": cells}, "m",
        str(ContentKey.from_parts("incompressible-flow.traction-mesh.v1", domain.identity, triangles)), metadata)
    field_metadata = result_metadata(domain, data, targets=targets, pressure_offset=offset, contribution=contribution)
    field_metadata.update(configuration="current", sampling="cell-average", weighting="surface-area", time=time,
                          sampleAxes=[{"axis": 1, "name": "time", "unit": "s", "ticks": [time]}])
    values = trace.traction(offset, contribution)[boundaries, None, :]
    return FieldValue(mesh, "cell", data["quantityKind"], data["unit"], np.asarray(values, dtype=data["dtype"]),
                      data.get("basis"), ("x", "y", "z"), field_metadata)
