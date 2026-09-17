"""Small spawn targets exercising the real managed computation service."""
import asyncio
import os
from pathlib import Path
import time

import numpy as np

from app.kernel.api import SolverImplementation, SolverResult


def initialize(prepared):
    Path(prepared["directory"], f"{os.getpid()}.pid").write_text(str(os.getppid()), encoding="utf-8")
    if prepared.get("mode") == "initialize-error":
        raise ValueError("initialization fixture failure")
    return prepared


def compute(prepared, index, cancellation):
    mode = prepared.get("mode")
    if mode == "crash":
        os._exit(29)
    if mode in {"hang", "solver-crash"}:
        time.sleep(60)
    if mode == "cooperative":
        while True:
            cancellation.raise_if_cancelled()
            time.sleep(.005)
    if mode == "error":
        raise ValueError("computation fixture failure")
    # Force completion out of order and exercise mmap in both directions.
    time.sleep(.02 if index % 2 == 0 else .001)
    return {"index": index, "values": prepared["values"] + index, "pid": os.getpid()}


async def run(invocation):
    from contextlib import aclosing

    async def crash():
        while len(list(Path(invocation.config["directory"]).glob("*.pid"))) < 2:
            await asyncio.sleep(.01)
        os._exit(31)

    crash_task = asyncio.create_task(crash()) if invocation.config.get("mode") == "solver-crash" else None
    prepared = dict(invocation.config, values=np.arange(200_000, dtype=float))
    results = []
    def batches():
        completed_before = len(results)
        for index in range(7):
            assert index - (len(results) - completed_before) < 4, "more than 2 * workers outstanding batches"
            yield index
    await invocation.progress({"workspace": invocation.resources.workspace_path})
    try:
        for _ in range(invocation.config.get("repeats", 1)):
            async with aclosing(invocation.execution.map_batches(
                __name__ + ":initialize", __name__ + ":compute", prepared, batches(), 2,
            )) as stream:
                async for result in stream:
                    results.append({"index": result["index"], "first": float(result["values"][0]),
                                    "last": float(result["values"][-1]), "pid": result["pid"]})
        return SolverResult(artifacts={"results": results}, observations={"pid": os.getpid()})
    finally:
        if crash_task is not None:
            crash_task.cancel()


async def torch_threads(invocation):
    invocation.execution.configure_torch()
    invocation.execution.configure_torch()
    import torch
    return SolverResult(observations={"intra": torch.get_num_threads(), "inter": torch.get_num_interop_threads()})


implementation = SolverImplementation(3, run)
torch_implementation = SolverImplementation(3, torch_threads)
