from app.runtime_kernel.api import SolverImplementation

from .formulation import run


implementation = SolverImplementation(abi_version=2, run=run)

__all__ = ["implementation"]
