"""Test-only product-entry observation; the production execution path is unchanged."""

from functools import wraps
import json
import os
from pathlib import Path
import sys
from time import perf_counter
from uuid import uuid4


_original_post_init = None
_original_child_target = None
_original_execute_child = None


def _event(kind, **details):
    directory = os.environ.get("CAEMBLE_SOLVER_EVENTS_DIR")
    if not directory:
        return
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    record = {"event": kind, "pid": os.getpid(), "test": os.environ.get("CAEMBLE_CURRENT_TEST", ""), **details}
    with (root / f"{os.getpid()}.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record) + "\n")


def observe_implementation(implementation):
    original = implementation.run
    module_name = original.__module__
    if not (module_name.startswith("app.solvers.") and module_name.endswith(".entry")):
        return
    if getattr(original, "_cae_observed", False):
        return

    @wraps(original)
    async def observed(invocation):
        tier = os.environ.get("CAEMBLE_TEST_TIER")
        if tier in {"lowcost", "collection"}:
            _event("blocked", solver=module_name)
            raise AssertionError(f"{tier} checks must not invoke product Solver {module_name}; use a small contract or --smoke")
        identifier = uuid4().hex
        started = perf_counter()
        _event("started", invocation=identifier, solver=module_name)
        outcome = "passed"
        try:
            return await original(invocation)
        except BaseException:
            outcome = "failed"
            raise
        finally:
            _event("finished", invocation=identifier, solver=module_name,
                   duration=perf_counter() - started, outcome=outcome)

    observed._cae_observed = True
    object.__setattr__(implementation, "run", observed)
    module = sys.modules.get(module_name)
    if module is not None and getattr(module, original.__name__, None) is original:
        setattr(module, original.__name__, observed)


def observed_child_main(request_connection, result_connection, cancellation_event):
    """Picklable spawn target which delegates all IPC and cleanup to the real child."""
    install()
    from app.kernel.execution.child import child_main

    child_main(request_connection, result_connection, cancellation_event)


def install():
    global _original_post_init, _original_child_target, _original_execute_child
    if _original_post_init is not None:
        return
    from app.kernel.api import SolverImplementation
    from app.kernel.execution import executor

    _original_post_init = SolverImplementation.__post_init__
    _original_child_target = executor.child_main
    _original_execute_child = executor.SpawnSolverExecutor._execute_child

    def post_init(self):
        _original_post_init(self)
        observe_implementation(self)

    SolverImplementation.__post_init__ = post_init
    executor.child_main = observed_child_main

    @wraps(_original_execute_child)
    async def execute_child(self, locator, *args, **kwargs):
        tier = os.environ.get("CAEMBLE_TEST_TIER")
        if tier in {"lowcost", "collection"} and locator.startswith("app.solvers."):
            _event("blocked", solver=locator, boundary="parent dispatch")
            raise AssertionError(f"{tier} checks must not invoke product Solver {locator}; use a small contract or --smoke")
        return await _original_execute_child(self, locator, *args, **kwargs)

    executor.SpawnSolverExecutor._execute_child = execute_child
    for name, module in tuple(sys.modules.items()):
        if name.startswith("app.solvers.") and name.endswith(".entry"):
            implementation = getattr(module, "implementation", None)
            if isinstance(implementation, SolverImplementation):
                observe_implementation(implementation)


def summarize(root):
    started, finished, blocked = {}, {}, []
    for path in sorted(Path(root).glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue  # An abruptly terminated child can leave an incomplete final line.
            if event["event"] == "started":
                started[event["invocation"]] = event
            elif event["event"] == "finished":
                finished[event["invocation"]] = event
            elif event["event"] == "blocked":
                blocked.append(event)
    return {"count": len(started), "duration": sum(item["duration"] for item in finished.values()),
            "unfinished": [item for identifier, item in started.items() if identifier not in finished],
            "blocked": blocked, "calls": list(finished.values())}
