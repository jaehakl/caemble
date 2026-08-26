from __future__ import annotations

import asyncio
import json
import os
import sys
import threading

from app.runtime_kernel.execution import SpawnSolverExecutor


async def main() -> None:
    threading.Thread(target=sys.stdin.buffer.readline, daemon=True).start()
    result = await SpawnSolverExecutor().execute(
        "tests.spawn_executor_fixtures:payload_size",
        {"payload": b"x" * 64_353},
    )
    print(json.dumps(result), flush=True)
    os._exit(0)


if __name__ == "__main__":
    asyncio.run(main())
