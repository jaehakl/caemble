"""ABI 3 selection between harmonic FEM and transient FDTD acoustics."""

from app.kernel.api import SolverImplementation, SolverInvocation, SolverResult

from .parameters import parameter


async def run(invocation: SolverInvocation) -> SolverResult:
    analysis = parameter(invocation.config["parameters"].get("analysis", "harmonic"))
    if analysis == "harmonic":
        from .harmonic_fem.run import run_harmonic
        return await run_harmonic(invocation)
    if analysis == "transient":
        from .transient_fdtd.run import run_transient
        return await run_transient(invocation)
    raise ValueError(f"unsupported acoustic analysis {analysis!r}")


implementation = SolverImplementation(abi_version=3, run=run)
