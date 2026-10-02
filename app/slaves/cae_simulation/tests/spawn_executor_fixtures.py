from __future__ import annotations

import asyncio
import os
from typing import Any

import numpy as np

from app.kernel.api import SolverImplementation, SolverInvocation, SolverResult


async def scale_values(invocation: SolverInvocation) -> SolverResult:
    await invocation.progress({"stage": "fixture", "pid": os.getpid()})
    values = np.asarray(invocation.inputs["values"])
    return SolverResult(
        artifacts={"values": values * invocation.config["gain"]},
        observations={"pid": os.getpid()},
    )


async def unregistered_runner(invocation: SolverInvocation) -> SolverResult:
    return SolverResult()


async def returns_mapping(invocation: SolverInvocation) -> dict[str, Any]:
    return {"outputs": {"invalid": 1}}


async def raises_error(invocation: SolverInvocation) -> SolverResult:
    raise ValueError("fixture solver failed")


async def wait_for_cancellation(invocation: SolverInvocation) -> SolverResult:
    while not invocation.cancellation.cancelled:
        await asyncio.sleep(0.01)
    invocation.cancellation.raise_if_cancelled()
    return SolverResult()


async def payload_size(invocation: SolverInvocation) -> SolverResult:
    return SolverResult(artifacts={"size": len(invocation.config["payload"]), "pid": os.getpid()})


async def blocks_forever(invocation: SolverInvocation) -> SolverResult:
    import time
    time.sleep(30)
    return SolverResult()


async def mmap_roundtrip(invocation: SolverInvocation) -> SolverResult:
    input_values = invocation.config["left"]
    input_alias = input_values is invocation.config["right"]
    input_values[0] = -100
    readonly = np.arange(24, dtype=np.float32).reshape(4, 6)
    readonly.flags.writeable = False
    writable = np.asfortranarray(np.arange(30, dtype=np.int16).reshape(5, 6))
    return SolverResult(artifacts={
        "inputAlias": input_alias,
        "inputFirst": int(input_values[0]),
        "readonly": readonly,
        "readonlyAlias": readonly,
        "writable": writable,
        "pid": os.getpid(),
    })


async def crashes_process(invocation: SolverInvocation) -> SolverResult:
    os._exit(23)


scale_values = SolverImplementation(3, scale_values)
invalid_result = SolverImplementation(3, returns_mapping)
raises_error = SolverImplementation(3, raises_error)
wait_for_cancellation = SolverImplementation(3, wait_for_cancellation)
payload_size = SolverImplementation(3, payload_size)
blocks_forever = SolverImplementation(3, blocks_forever)
mmap_roundtrip = SolverImplementation(3, mmap_roundtrip)
crashes_process = SolverImplementation(3, crashes_process)
