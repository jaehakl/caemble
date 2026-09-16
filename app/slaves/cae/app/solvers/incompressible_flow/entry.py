"""ABI 3 assembly for steady Stokes or accepted Navier--Stokes time windows."""

from app.kernel.api import SolverImplementation, SolverResult, StatePatch

from .domain import build_domain, domain_request, parameter
from .formulation import solve_stokes
from .outputs import build_outputs
from .state import history_values, initial_state, read_checkpoint, read_settings


async def run(invocation):
    analysis = parameter(invocation.config["parameters"]["analysis"])
    controls, clock = read_settings(invocation.config, analysis)
    saved = invocation.state.get("incompressible_flow", {}).get(invocation.task_name)
    if analysis == "steady-stokes" and saved is not None:
        raise ValueError("flow checkpoint cannot continue with a different analysis model (steady-stokes)")
    request = domain_request(invocation, controls)
    patch, samples, time = StatePatch(), None, 0.
    diagnostics = {"stepCount": 0, "retryCount": 0, "lastDt": 0., "maxCourant": 0.}
    if analysis == "steady-stokes":
        domain = await build_domain(invocation, request)
        solution = await solve_stokes(
            domain.mesh, domain.density, domain.viscosity, domain.gravity,
            domain.boundary_velocity, domain.boundary_pressure,
            max_iterations=controls["maxIterations"], tolerance=controls["tolerance"],
            cancellation=invocation.cancellation, progress=invocation.progress,
        )
        diagnostics["iterationCount"] = solution.iterations
    else:
        from .evolution import advance_window
        from .transient import PreparedTransientFlow

        domain = await build_domain(invocation, request) if saved is None else read_checkpoint(saved, request, clock)
        prepared = PreparedTransientFlow(domain.mesh, domain.density, domain.viscosity, domain.gravity,
                                         domain.boundary_velocity, domain.boundary_pressure)
        if saved is None:
            initial = await prepared.initialize(max_iterations=controls["maxIterations"],
                tolerance=controls["tolerance"], cancellation=invocation.cancellation, progress=invocation.progress)
            saved = initial_state(domain, initial, clock)
        saved, solution, diagnostics = await advance_window(invocation, domain, saved, clock, controls, prepared)
        time, samples = saved["time"], history_values(saved)
        diagnostics["stepCount"] = saved["steps"]
        if "incompressible_flow" not in invocation.state:
            patch = patch.put(("incompressible_flow",), {})
        patch = patch.put(("incompressible_flow", invocation.task_name), saved)
    artifacts, visualizations = build_outputs(invocation, domain, solution, samples=samples, time=time)
    if invocation.cancellation is not None:
        invocation.cancellation.raise_if_cancelled()
    return SolverResult(
        state_patch=patch, artifacts=artifacts, visualizations=visualizations,
        observations={
            **diagnostics, "analysis": analysis, "time": time,
            "massResidual": solution.mass_residual,
            "momentumResidual": solution.momentum_residual,
            "pressureResidual": solution.pressure_residual,
            "pressureReference": domain.metadata["pressureReference"],
        },
    )


implementation = SolverImplementation(abi_version=3, run=run)
