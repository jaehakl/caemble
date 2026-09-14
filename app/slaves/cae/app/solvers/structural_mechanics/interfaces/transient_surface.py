"""Actual, compact surface samples; independent of prediction and recorded history."""

from dataclasses import dataclass, field

import numpy as np

from app.kernel.api import BundleValue, FieldValue, UnstructuredMeshValue


@dataclass
class TransientSurfaceSamples:
    surfaces: dict[str, tuple[UnstructuredMeshValue, np.ndarray]]
    nodes: np.ndarray
    times: list[float] = field(default_factory=list)
    velocities: list[np.ndarray] = field(default_factory=list)
    frame_kind: str = "initial"
    coupling_converged: bool = True
    coupling_iteration: int = 0


def transient_surface_motion(samples, key):
    domain, nodes = samples.surfaces[key]
    times = np.asarray(samples.times, dtype=np.float64)
    if not len(times) or not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0):
        raise ValueError("actual surface motion requires finite, strictly increasing sample times")
    if samples.frame_kind == "solved-window" and len(times) < 2:
        raise ValueError("actual solved surface motion requires a positive time interval")
    velocities = np.moveaxis(np.asarray(samples.velocities, dtype=np.float64)[:, np.searchsorted(samples.nodes, nodes)], 0, 1)
    field_value = FieldValue(
        domain, "node", "kinematics.Velocity", "m.s-1", velocities,
        np.eye(3), ("x", "y", "z"),
        {"configuration": "reference", "sampleAxes": [{"axis": 1, "name": "time", "unit": "s", "ticks": times}]},
    )
    return BundleValue("caemble.mechanics/transient-surface-motion@1", {
        "times": {"value": times, "axes": [{"ticks": times, "unit": "s"}]}, "velocity": field_value,
    }, {
        "configuration": "reference", "timeOrigin": 0.0,
        "startTime": float(times[0]), "endTime": float(times[-1]), "frameKind": samples.frame_kind,
        "couplingConverged": bool(samples.coupling_converged), "couplingIteration": int(samples.coupling_iteration),
        "sourceModelIdentity": domain.metadata["sourceModelIdentity"], "surfaceTargets": domain.metadata["surfaceTargets"],
    })
