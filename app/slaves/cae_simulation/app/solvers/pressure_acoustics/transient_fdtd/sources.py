"""Passive face rules and bounded, volume-preserving source time integration."""

from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np

from app.kernel.api import BundleValue, FieldValue, UnstructuredMeshValue
from app.kernel.api.units import convert_ucum_value
from app.methods.coupling.surface import planar_face_flux_operator
from app.methods.time.integration import integrate_piecewise_linear

from ..parameters import parameter


@dataclass(frozen=True)
class AcousticFaceRule:
    axis: int
    side: int
    method: str
    parameters: dict


def prepare_face_rules(grid, rules):
    result, occupied = [], set()
    for rule in rules:
        selected = set()
        for target in rule["target"]:
            if target not in grid.boundary_regions:
                raise ValueError(f"acoustic surface target {target!r} has no fluid boundary")
            selected.update(grid.boundary_regions[target])
        if not selected:
            raise ValueError("each acoustic boundary condition requires a nonempty surface selection")
        if occupied.intersection(selected):
            raise ValueError("acoustic boundary conditions cannot overlap on the same physical face")
        occupied.update(selected)
        method = rule["methodId"]
        parameters = {k: parameter(v) for k, v in rule.get("parameters", {}).items()}
        if method == "acoustics.impedance":
            resistance = float(parameters["resistance"])
            if not np.isfinite(resistance) or resistance <= 0:
                raise ValueError("acoustic impedance resistance must be finite and positive")
        elif method == "acoustics.tone-burst-velocity":
            values = [float(parameters[k]) for k in ("amplitude", "frequency", "startTime", "duration")]
            if not np.all(np.isfinite(values)) or values[1] <= 0 or values[2] < 0 or values[3] <= 0:
                raise ValueError("tone burst requires finite amplitude, positive frequency/duration and nonnegative startTime")
        elif method == "acoustics.transient-surface-motion":
            if len(selected) != 1 or any(r.method == method for r in result):
                raise ValueError("transient surface motion requires one planar fluid patch")
        else:
            raise ValueError(f"unsupported transient acoustic boundary condition {method!r}")
        result.extend(AcousticFaceRule(axis, side, method, parameters) for axis, side in sorted(selected))
    return result


def tone_burst_average(parameters, start, end):
    """Exact integral of the signed Hann-windowed sine, including clipped support."""
    origin, duration = float(parameters["startTime"]), float(parameters["duration"])
    left, right = max(start - origin, 0.), min(end - origin, duration)
    if right <= left:
        return 0.
    frequency = float(parameters["frequency"])
    angular = 2 * np.pi * np.asarray([frequency, frequency + 1 / duration, frequency - 1 / duration])
    integral = (right - left) * np.sin(angular * (left + right) / 2) * np.sinc(angular * (right - left) / (2 * np.pi))
    return float(parameters["amplitude"]) * float(np.array([.5, -.25, -.25]) @ integral) / (end - start)


def prepare_surface_motion(value, grid, rule, start, end, tolerance):
    if not isinstance(value, BundleValue) or value.bundle_type != "caemble.mechanics/transient-surface-motion@1":
        raise ValueError("transientSurfaceMotion requires a transient surface motion bundle")
    metadata = value.metadata
    if metadata.get("configuration") != "reference" or metadata.get("frameKind") != "solved-window" or metadata.get("couplingConverged") is not True:
        raise ValueError("transientSurfaceMotion accepts only a converged solved-window on the reference configuration")
    if metadata.get("timeOrigin") != 0.:
        raise ValueError("transientSurfaceMotion must use the common run time origin 0 s")
    coordinates = value.members["times"]
    times = np.asarray(coordinates["value"] if isinstance(coordinates, Mapping) else coordinates, dtype=float)
    if times.ndim != 1 or len(times) < 2 or not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0):
        raise ValueError("transientSurfaceMotion requires an increasing positive-length time interval")
    time_axes = coordinates.get("axes", ()) if isinstance(coordinates, Mapping) else ()
    if len(time_axes) != 1 or time_axes[0].get("unit") != "s" or not np.array_equal(time_axes[0].get("ticks"), times):
        raise ValueError("transientSurfaceMotion bundle time coordinates must be explicitly expressed in seconds")
    if (abs(times[0] - start) > tolerance or abs(times[-1] - end) > tolerance
            or metadata.get("startTime") != times[0] or metadata.get("endTime") != times[-1]):
        raise ValueError("transientSurfaceMotion interval must start at the acoustic checkpoint and end on its planned window without gap or overlap")
    velocity = value.members["velocity"]
    if not isinstance(velocity, FieldValue) or not isinstance(velocity.domain, UnstructuredMeshValue):
        raise ValueError("transientSurfaceMotion requires a self-contained triangular velocity field")
    domain = velocity.domain
    values = np.asarray(velocity.values)
    if not metadata.get("sourceModelIdentity") or not domain.identity:
        raise ValueError("transientSurfaceMotion requires source model and surface domain identities")
    if (velocity.location != "node" or velocity.quantity_kind != "kinematics.Velocity"
            or velocity.components != ("x", "y", "z") or not np.array_equal(velocity.basis, np.eye(3))
            or not isinstance(domain.cells, Mapping) or set(domain.cells) != {"tri3"}
            or velocity.metadata.get("configuration") != "reference"
            or values.shape != (len(domain.points), len(times), 3) or np.iscomplexobj(values)
            or not np.all(np.isfinite(values))):
        raise ValueError("transientSurfaceMotion requires finite real Cartesian [node,time,xyz] velocity on tri3 cells")
    axes = velocity.metadata.get("sampleAxes", ())
    if (len(axes) != 1 or axes[0].get("axis") != 1 or axes[0].get("name") != "time"
            or axes[0].get("unit") != "s" or not np.array_equal(axes[0].get("ticks"), times)):
        raise ValueError("transientSurfaceMotion time axis must match its bundle coordinates")
    points, faces = grid.face_mesh(rule.axis, rule.side)
    source_points = np.asarray(domain.points) * convert_ucum_value(1, domain.unit, "m")
    operator = planar_face_flux_operator(source_points, domain.cells["tri3"], points, faces)
    # Spatial projection commutes with the piecewise-linear time integral. Project
    # once per source sample, then integrate the face waveform for each FDTD step.
    cartesian = np.moveaxis(values, 1, 2).reshape(len(domain.points) * 3, len(times))
    area = float(np.prod(np.delete(grid.spacing, rule.axis)))
    normal_velocity = (operator @ cartesian).T * convert_ucum_value(1, velocity.unit, "m.s-1") / area
    return times, normal_velocity, (metadata["sourceModelIdentity"], domain.identity)


def prescribed_velocities(rules, motion, grid, start, end):
    values = {}
    for rule in rules:
        if rule.method == "acoustics.tone-burst-velocity":
            values[(rule.axis, rule.side)] = tone_burst_average(rule.parameters, start, end)
        elif rule.method == "acoustics.transient-surface-motion":
            times, velocities, _ = motion
            # Only the already-validated window endpoints can differ by roundoff.
            # The common numerical helper itself remains strictly bounded.
            average = integrate_piecewise_linear(times, velocities, max(start, times[0]), min(end, times[-1])) / (end - start)
            shape = tuple(n for j, n in enumerate(grid.shape) if j != rule.axis)
            values[(rule.axis, rule.side)] = average.reshape(shape)
    return values
