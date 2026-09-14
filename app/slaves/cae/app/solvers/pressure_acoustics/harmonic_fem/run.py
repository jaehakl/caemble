"""Harmonic FEM configuration, solve and result composition."""

import numpy as np

from app.kernel.api import SolverResult, StatePatch

from .boundaries import prepare_boundaries
from ..parameters import parameter
from .domain import build_geometry_model
from .formulation import prepare_operators
from .harmonic import solve_harmonic
from .outputs import build_outputs


async def run_harmonic(invocation):
    if "transientSurfaceMotion" in invocation.inputs:
        raise ValueError("transientSurfaceMotion is supported only by transient acoustics")
    if any(rule["methodId"] == "acoustics.time" for rule in invocation.config["initializations"]):
        raise ValueError("acoustics.time is supported only by transient analysis")
    spectra = [rule for rule in invocation.config["initializations"] if rule["methodId"] == "acoustics.spectrum"]
    if len(spectra) != 1:
        raise ValueError("pressure acoustics requires one acoustics.spectrum initialization")
    frequencies = np.asarray(parameter(spectra[0]["parameters"]["frequencies"]), dtype=float)
    if (frequencies.ndim != 1 or not len(frequencies) or not np.all(np.isfinite(frequencies))
            or np.any(frequencies <= 0) or np.any(np.diff(frequencies) <= 0)):
        raise ValueError("acoustic frequencies must be finite, positive and strictly increasing")
    model = await build_geometry_model(invocation)
    operators = prepare_operators(model, invocation.cancellation)
    motion = invocation.inputs.get("surfaceMotion")
    boundaries = prepare_boundaries(model, invocation.config["boundaryConditions"], frequencies,
                                    None if motion is None else motion.value)
    solution = await solve_harmonic(operators, boundaries, frequencies, invocation.cancellation, invocation.progress)
    artifacts, visuals = build_outputs(invocation.config, invocation.descriptor, model, solution)
    return SolverResult(state_patch=StatePatch(), artifacts=artifacts, visualizations=visuals,
                        observations={"relativeResidual": float(np.max(solution.relative_residuals)), "frequencyCount": len(frequencies)})
