from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def read_stdin_line() -> str:
    buffer = getattr(sys.stdin, "buffer", None)
    if buffer is None:
        return sys.stdin.readline()
    raw_line = buffer.readline()
    if not raw_line:
        return ""
    return raw_line.decode("utf-8")


def emit(message: dict[str, Any]) -> None:
    line = json.dumps(message, ensure_ascii=False) + "\n"
    buffer = getattr(sys.stdout, "buffer", None)
    if buffer is None:
        sys.stdout.write(line)
        sys.stdout.flush()
        return
    buffer.write(line.encode("utf-8"))
    buffer.flush()


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    return parser.parse_args()
