from __future__ import annotations

import asyncio

from app.runtime_kernel.execution.messages import RemoteError


class SolverExecutorError(RuntimeError):
    """Base class for invocation-process failures."""


class SolverPayloadError(SolverExecutorError):
    """The invocation or result could not cross the process boundary."""


class SolverProtocolError(SolverExecutorError):
    """The child violated the executor message protocol."""


class RemoteSolverError(SolverExecutorError):
    def __init__(self, locator: str, error: RemoteError) -> None:
        self.locator = locator
        self.remote = error
        super().__init__(
            f"solver {locator} raised {error.module}.{error.name}: {error.message}\n"
            f"Remote traceback:\n{error.traceback}"
        )


class SolverProcessExitedError(SolverExecutorError):
    def __init__(self, locator: str, exit_code: int | None, child_pid: int | None) -> None:
        self.locator = locator
        self.exit_code = exit_code
        self.child_pid = child_pid
        super().__init__(
            f"solver process for {locator} exited without a result "
            f"(pid={child_pid}, exitCode={exit_code})"
        )


class SolverExecutionTimeout(SolverExecutorError, TimeoutError):
    def __init__(self, locator: str, timeout: float) -> None:
        self.locator = locator
        self.timeout = timeout
        super().__init__(f"solver {locator} exceeded its {timeout:g}s invocation timeout")


class SolverExecutionStartupTimeout(SolverExecutorError, TimeoutError):
    def __init__(self, locator: str, timeout: float) -> None:
        self.locator = locator
        self.timeout = timeout
        super().__init__(f"solver {locator} did not start within {timeout:g}s")


class SolverExecutionCancelled(asyncio.CancelledError):
    def __init__(self, locator: str) -> None:
        self.locator = locator
        super().__init__(f"solver {locator} invocation was cancelled")
