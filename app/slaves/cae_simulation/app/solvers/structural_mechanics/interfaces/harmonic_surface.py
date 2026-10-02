"""Physical surface motion independent of structural DOFs and recorded Boxes."""

import numpy as np

from app.kernel.api import BundleValue, FieldValue

from ..model import HarmonicSolution
from .surface import physical_surface


def harmonic_surface_motion(model, solution: HarmonicSolution, targets):
    if not isinstance(solution, HarmonicSolution):
        raise ValueError("fea.harmonic-surface-motion requires harmonic analysis")
    domain, nodes = physical_surface(model, targets)
    phasor = {"timeConvention": "exp(+i*omega*t)", "amplitude": "peak", "configuration": "reference"}
    frequencies = solution.frequencies
    velocities = np.moveaxis(1j * (2 * np.pi * frequencies)[:, None, None] * solution.complex_displacement[:, nodes, :3], 0, 1)
    field = FieldValue(
        domain, "node", "kinematics.Velocity", "m.s-1", velocities.astype(np.complex64),
        np.eye(3), ("x", "y", "z"),
        {"sampleAxes": [{"axis": 1, "name": "frequency", "unit": "Hz", "ticks": frequencies}], **phasor},
    )
    return BundleValue("caemble.mechanics/harmonic-surface-motion@1", {
        "frequencies": {"value": frequencies, "axes": [{"ticks": frequencies}]}, "velocity": field,
    }, {**phasor, "sourceModelIdentity": model.identity, "surfaceTargets": domain.metadata["surfaceTargets"]})
