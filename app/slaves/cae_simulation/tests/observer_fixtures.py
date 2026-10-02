"""Synthetic ABI entry for observing real spawn IPC without any physics."""

from app.kernel.api import SolverImplementation, SolverResult


async def run(invocation):
    return SolverResult()


# Exercise the product-entry observer with a deliberately synthetic callable.
run.__module__ = "app.solvers.observer_fixture.entry"
implementation = SolverImplementation(abi_version=3, run=run)
