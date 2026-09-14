"""Fluid-outward velocity and passive impedance boundary integration."""

from collections.abc import Mapping

import numpy as np
from scipy import sparse

from app.kernel.api import BundleValue, FieldValue, UnstructuredMeshValue
from app.kernel.api.units import convert_ucum_value
from app.methods.coupling.surface import planar_surface_operator

from ..parameters import parameter
from .model import AcousticBoundaries


def boundary_mass(points, faces):
    triangles = np.asarray(points)[faces]
    areas = np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1) / 2
    if np.any(areas <= 0):
        raise ValueError("acoustic boundary contains a degenerate triangle")
    local = areas[:, None, None] / 12 * (np.ones((3, 3)) + np.eye(3))
    return sparse.coo_matrix((local.ravel(), (np.repeat(faces, 3, axis=1).ravel(), np.tile(faces, (1, 3)).ravel())),
                             shape=(len(points), len(points))).tocsr()


def surface_motion_load(value, model, faces, frequencies):
    if not isinstance(value, BundleValue) or value.bundle_type != "caemble.mechanics/harmonic-surface-motion@1":
        raise ValueError("surfaceMotion requires a harmonic surface motion bundle")
    for key, expected in (("timeConvention", "exp(+i*omega*t)"), ("amplitude", "peak"), ("configuration", "reference")):
        if value.metadata.get(key) != expected:
            raise ValueError(f"surfaceMotion requires {key}={expected!r}")
    coordinates = value.members["frequencies"]
    source_frequencies = np.asarray(coordinates["value"] if isinstance(coordinates, Mapping) else coordinates)
    if not np.array_equal(source_frequencies, frequencies):
        raise ValueError("surfaceMotion frequency coordinates must exactly match the acoustic sweep")
    velocity = value.members["velocity"]
    if not isinstance(velocity, FieldValue) or not isinstance(velocity.domain, UnstructuredMeshValue):
        raise ValueError("surfaceMotion velocity requires a self-contained triangular mesh field")
    domain = velocity.domain
    if (velocity.location != "node" or velocity.components != ("x", "y", "z")
            or velocity.quantity_kind != "kinematics.Velocity"
            or np.asarray(velocity.basis).shape != (3, 3)
            or not np.array_equal(velocity.basis, np.eye(3))
            or not isinstance(domain.cells, Mapping) or set(domain.cells) != {"tri3"}):
        raise ValueError("surfaceMotion requires Cartesian nodal velocity on tri3 cells")
    values = np.asarray(velocity.values)
    if values.shape != (len(domain.points), len(frequencies), 3) or not np.all(np.isfinite(values)):
        raise ValueError("surfaceMotion velocity must have finite [node, frequency, xyz] values")
    axes = velocity.metadata.get("sampleAxes", ())
    if (len(axes) != 1 or axes[0].get("axis") != 1 or axes[0].get("name") != "frequency"
            or axes[0].get("unit") != "Hz" or not np.array_equal(axes[0].get("ticks"), frequencies)):
        raise ValueError("surfaceMotion velocity frequency axis must match its bundle coordinates")
    source_points = np.asarray(domain.points) * convert_ucum_value(1, domain.unit, "m")
    operator = planar_surface_operator(source_points, domain.cells["tri3"], model.points, faces)
    cartesian = np.moveaxis(values, 1, 2).reshape(len(domain.points) * 3, len(frequencies))
    return operator @ cartesian * convert_ucum_value(1, velocity.unit, "m.s-1")


def prepare_boundaries(model, rules, frequencies, surface_motion=None):
    frequencies = np.asarray(frequencies, dtype=float)
    count = len(model.points)
    impedance = sparse.csr_matrix((count, count), dtype=float)
    load = np.zeros((count, len(frequencies)), dtype=complex)
    occupied, motion_count = set(), 0
    for rule in rules:
        method = rule["methodId"]
        selected_faces = {}
        for target in rule["target"]:
            if target not in model.boundary_regions:
                raise ValueError(f"acoustic surface target {target!r} has no fluid boundary")
            for face in model.boundary_regions[target]["faces"]:
                selected_faces.setdefault(tuple(sorted(face)), face)
        if not selected_faces:
            raise ValueError("each acoustic boundary condition requires a nonempty surface selection")
        faces = np.asarray(list(selected_faces.values()), dtype=int)
        face_keys = set(selected_faces)
        if occupied.intersection(face_keys):
            raise ValueError("acoustic boundary conditions cannot overlap on the same physical face")
        occupied.update(face_keys)
        parameters = {key: parameter(value) for key, value in rule.get("parameters", {}).items()}
        if method == "acoustics.normal-velocity":
            amplitude, phase = float(parameters["amplitude"]), float(parameters["phase"])
            if not np.isfinite(amplitude) or not np.isfinite(phase) or amplitude < 0:
                raise ValueError("normal velocity requires nonnegative finite amplitude and finite phase")
            load += (boundary_mass(model.points, faces) @ np.ones(count))[:, None] * amplitude * np.exp(1j * phase)
        elif method == "acoustics.impedance":
            resistance = float(parameters["resistance"])
            if not np.isfinite(resistance) or resistance <= 0:
                raise ValueError("acoustic impedance resistance must be finite and positive")
            impedance += boundary_mass(model.points, faces) / resistance
        elif method == "acoustics.surface-motion":
            motion_count += 1
            if surface_motion is None or motion_count != 1:
                raise ValueError("acoustics.surface-motion requires one connected surfaceMotion input and one patch")
            load += surface_motion_load(surface_motion, model, faces, frequencies)
        else:
            raise ValueError(f"unsupported acoustic boundary condition {method!r}")
    if surface_motion is not None and motion_count != 1:
        raise ValueError("surfaceMotion input requires an acoustics.surface-motion boundary")
    return AcousticBoundaries(impedance, load)
