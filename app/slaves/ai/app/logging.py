from __future__ import annotations

import sys
import traceback
from datetime import datetime, timezone


def log(message: str) -> None:
    timestamp = datetime.now(timezone.utc).isoformat()
    print(f"{timestamp} {message}", file=sys.stderr, flush=True)


def log_exception(message: str, exc: BaseException) -> None:
    log(f"{message}: {exc}")
    traceback.print_exception(type(exc), exc, exc.__traceback__, file=sys.stderr)
