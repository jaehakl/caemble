"""Prepare the FDTD problem, allocate its engine, advance time, and publish outputs."""

import math
from time import perf_counter

from app.kernel.api import SolverImplementation, SolverInvocation, SolverResult

from .detectors import prepare_detectors
from .formulation import allocate_simulation, propagate
from .setup import _positive_float, prepare_domain
from .sources import prepare_sources


async def run(invocation: SolverInvocation) -> SolverResult:
    prepared = await prepare_domain(invocation)
    parameters = invocation.config["parameters"]
    simulation_time = _positive_float(parameters["simulationTime"], "simulationTime")
    step_count = math.ceil(simulation_time / prepared.dt)
    source_plans = await prepare_sources(invocation, prepared)
    output_plans = await prepare_detectors(invocation, prepared)

    engine, sources, time_detectors, spectral_detectors = allocate_simulation(
        prepared, source_plans, output_plans, parameters, simulation_time,
    )
    propagation_started = perf_counter()
    await propagate(
        engine, sources, time_detectors, spectral_detectors, step_count,
        invocation.progress, invocation.cancellation,
    )
    if invocation.progress is not None:
        await invocation.progress({"stage": "fdtd-propagation", "completed": step_count,
                                   "total": step_count, "seconds": perf_counter() - propagation_started})

    pml_cell_size = _positive_float(parameters["pmlCellSize"], "pmlCellSize")
    center_wavelength = _positive_float(parameters["pmlCenterWavelength"], "pmlCenterWavelength")
    return SolverResult(
        artifacts={detector.key: detector.artifact() for detector in (*time_detectors, *spectral_detectors)},
        observations={
            "timeSteps": step_count,
            "totalCells": math.prod(prepared.domain.topology.global_shape),
            "device": str(engine.electric.device),
            "pmlResolutionWarning": (
                "pmlCellSize exceeds pmlCenterWavelength/15; CPML absorption may be inaccurate"
                if pml_cell_size > center_wavelength / 15.0 else ""
            ),
        },
    )


implementation = SolverImplementation(abi_version=3, run=run)

__all__ = ["implementation"]
