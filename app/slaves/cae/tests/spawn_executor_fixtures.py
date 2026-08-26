from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import Any

import numpy as np


async def legacy_run(context: Any) -> dict[str, Any]:
    await context.progress({"stage": "fixture", "pid": os.getpid()})
    values = np.asarray(context.inputs["values"])
    return {
        "state": context.state,
        "outputs": {"values": values * context.config["gain"]},
        "pid": os.getpid(),
    }


async def legacy_solver_context(context: Any) -> dict[str, Any]:
    assert type(context).__name__ == "SolverContext"
    await context.progress({"stage": "legacy-adapter"})
    return {
        "state": context.state,
        "artifacts": {"value": context.inputs["source"] * 2},
    }


async def legacy_mutates_state(context: Any) -> dict[str, Any]:
    context.state["step"] += 1
    return {"state": context.state, "artifacts": {}}


@dataclass(frozen=True, slots=True)
class _V2Implementation:
    abi_version: int = 2

    async def run(self, invocation: dict[str, Any]) -> dict[str, Any]:
        await invocation["progress"]({"stage": "abi-v2"})
        return {
            "state": invocation["state"],
            "outputs": {"abiVersion": self.abi_version},
            "pid": os.getpid(),
        }


v2_implementation = _V2Implementation()


async def raises_error(context: Any) -> None:
    del context
    raise ValueError("fixture solver failed")


async def wait_for_cancellation(context: dict[str, Any]) -> None:
    while not context["cancellation"].is_set():
        await asyncio.sleep(0.01)
    context["cancellation"].raise_if_cancelled()


def payload_size(context: dict[str, Any]) -> dict[str, int]:
    return {"size": len(context["payload"]), "pid": os.getpid()}


def blocks_forever(context: Any) -> None:
    del context
    import time

    time.sleep(30)


async def mmap_roundtrip(context: dict[str, Any]) -> dict[str, Any]:
    input_values = context["left"]
    input_alias = input_values is context["right"]
    input_values[0] = -100

    readonly = np.arange(24, dtype=np.float32).reshape(4, 6)
    readonly.flags.writeable = False
    writable = np.asfortranarray(np.arange(30, dtype=np.int16).reshape(5, 6))
    return {
        "inputAlias": input_alias,
        "inputFirst": int(input_values[0]),
        "readonly": readonly,
        "readonlyAlias": readonly,
        "writable": writable,
        "pid": os.getpid(),
    }


def crashes_process(context: Any) -> None:
    del context
    os._exit(23)
