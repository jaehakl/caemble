"""Count actual public CLI input-build attempts, including expected validation failures."""

from functools import wraps
import json
import os
from pathlib import Path
import subprocess
from time import perf_counter
from uuid import uuid4


_original_run = None


def _event(kind, **details):
    directory = os.environ.get("CAEMBLE_CLI_BUILD_EVENTS_DIR")
    if not directory:
        return
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    event = {"event": kind, "pid": os.getpid(), "test": os.environ.get("CAEMBLE_CURRENT_TEST", ""), **details}
    with (root / f"{os.getpid()}.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(event) + "\n")


def install():
    global _original_run
    if _original_run is not None or not os.environ.get("CAEMBLE_CLI_BUILD_EVENTS_DIR"):
        return
    _original_run = subprocess.run

    @wraps(_original_run)
    def run(*popenargs, **kwargs):
        command = popenargs[0] if popenargs else kwargs.get("args")
        arguments = [str(part) for part in command] if isinstance(command, (tuple, list)) else []
        public_cli = any(Path(part).name.lower() in {"caemble.cjs", "caemble.cmd", "caemble"} for part in arguments[:2])
        input_build = any(first == "experiment" and second == "build" for first, second in zip(arguments, arguments[1:]))
        if not public_cli or not input_build:
            return _original_run(*popenargs, **kwargs)
        identifier = uuid4().hex
        started = perf_counter()
        _event("started", attempt=identifier, command=arguments)
        details = {"outcome": "failed"}
        try:
            result = _original_run(*popenargs, **kwargs)
            details.update(outcome="succeeded" if result.returncode == 0 else "failed", returncode=result.returncode)
            return result
        except BaseException as error:
            details.update(error=type(error).__name__, returncode=getattr(error, "returncode", None))
            raise
        finally:
            _event("finished", attempt=identifier, duration=perf_counter() - started, **details)

    subprocess.run = run


def summarize(root):
    started, finished = {}, {}
    for path in sorted(Path(root).glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event["event"] == "started":
                started[event["attempt"]] = event
            elif event["event"] == "finished":
                finished[event["attempt"]] = event
    return {"attempts": len(started),
            "succeeded": sum(item["outcome"] == "succeeded" for item in finished.values()),
            "failed": sum(item["outcome"] == "failed" for item in finished.values()),
            "unfinished": [item for identifier, item in started.items() if identifier not in finished],
            "duration": sum(item["duration"] for item in finished.values()), "calls": list(finished.values())}
