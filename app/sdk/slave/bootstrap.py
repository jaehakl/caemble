"""Wait for launcher containment before importing a slave application."""
from __future__ import annotations

import argparse
import json
import runpy
import sys

from sdk.slave.execution import configure_process, execution_context
from sdk.slave.io import read_stdin_line


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--module", required=True)
    parser.add_argument("--worker", action="store_true", required=True)
    args = parser.parse_args()
    try:
        context = execution_context()
        if context is None:
            raise ValueError("Managed slave bootstrap requires an execution allocation")
        gate = json.loads(read_stdin_line())
        if gate.get("type") != "bootstrap.start":
            raise ValueError("Expected bootstrap.start after process containment")
        configure_process(context)
    except Exception as error:
        # Invalid allocation JSON cannot be parsed again by the normal emitter.
        print(json.dumps({"type": "error", "code": "bootstrap_failed", "detail": str(error)}, ensure_ascii=False), flush=True)
        raise SystemExit(1) from error
    sys.argv = [args.module, "--worker"]
    runpy.run_module(args.module, run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main()
