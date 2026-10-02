from __future__ import annotations

import asyncio
import json
import os
import sys
import threading

from app.kernel.execution import SpawnSolverExecutor
from tests.solver_test_support import invocation


async def main() -> None:
    threading.Thread(target=sys.stdin.buffer.readline, daemon=True).start()
    result = await SpawnSolverExecutor().execute(
        "tests.spawn_executor_fixtures:payload_size",
        invocation({"payload": b"x" * 64_353}),
    )
    print(json.dumps(result.artifacts), flush=True)
    os._exit(0)


if __name__ == "__main__":
    asyncio.run(main())
