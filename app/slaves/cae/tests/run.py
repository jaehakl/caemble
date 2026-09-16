"""Run from app/slaves/cae: python -m tests.run [affected|quick|full]."""

import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from time import perf_counter
from uuid import uuid4

from tests.selection import changed_paths, select_changes


THREAD_LIMITS = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "BLIS_NUM_THREADS", "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS")


def main(argv=None):
    run_started = perf_counter()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("suite", nargs="?", choices=("affected", "quick", "full"), default="affected")
    parser.add_argument("--base", default="HEAD", help="Git revision compared with staged/unstaged/untracked files")
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--list", action="store_true", help="Collect and explain selections without running checks")
    parser.add_argument("--report", type=Path, help="New empty report directory; defaults to .work/cae-tests/<run>")
    parser.add_argument("--tests", nargs="+", help="Explicit CAE test files/node IDs for focused verification")
    options = parser.parse_args(argv)
    if options.jobs < 1:
        parser.error("--jobs must be positive")
    cae = Path(__file__).resolve().parents[1]
    repo = cae.parents[2]
    root = (options.report or repo / ".work/cae-tests" / (datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + uuid4().hex[:8])).resolve()
    if root.exists() and any(root.iterdir()):
        parser.error("--report must be a new or empty directory")
    selection = None
    if options.suite == "affected":
        try:
            selection = select_changes(changed_paths(repo, options.base))
        except (ValueError, subprocess.CalledProcessError) as error:
            parser.error(str(error))
    root.mkdir(parents=True, exist_ok=True)
    temporary = root / "tmp"
    temporary.mkdir()
    for name in THREAD_LIMITS:
        os.environ[name] = "1"
    for name in ("TMPDIR", "TEMP", "TMP"):
        os.environ[name] = str(temporary)
    os.environ["CAEMBLE_TEST_RUN_DIR"] = str(root)
    os.chdir(cae)
    # Set limits and temporary ownership before pytest imports NumPy, Torch or fixtures.
    import tempfile
    tempfile.tempdir = str(temporary)
    import pytest

    arguments = [*(options.tests or ["tests"]), "-m", "not cuda", "-p", "tests.reporting",
                 f"--cae-suite={options.suite}", f"--cae-report={root}",
                 "--durations=25", "--durations-min=1", "--tb=short"]
    actions = sorted(selection.actions) if selection else []
    if selection:
        payload = {key: sorted(value) if isinstance(value, set) else value for key, value in asdict(selection).items()}
        selected = root / "selection.json"
        selected.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        arguments.append(f"--cae-selection={selected}")
        for path, reason in selection.reasons.items():
            print(f"{path}: {reason}", flush=True)
        for path, reason in selection.ignored.items():
            print(f"{path}: {reason}", flush=True)
    if options.list:
        arguments.extend(("--collect-only", "-q", "-n", "0"))
    elif options.jobs > 1:
        arguments.extend(("-n", str(options.jobs), "--dist", "worksteal", "-q"))
    else:
        arguments.extend(("-n", "0", "-q"))
    print(f"CAE {options.suite}; workers={1 if options.list else options.jobs}; report={root}", flush=True)
    print("Additional checks: " + (", ".join(actions) or "none"), flush=True)
    (root / "invocation.json").write_text(json.dumps({"arguments": arguments, "actions": actions,
        "base": options.base, "jobs": options.jobs, "threadLimits": dict.fromkeys(THREAD_LIMITS, "1")}, indent=2), encoding="utf-8")
    exitstatus = int(pytest.main(arguments))
    records = []
    # An affected selection with only documentation/external changes has no CAE tests.
    if (exitstatus == pytest.ExitCode.NO_TESTS_COLLECTED and selection is not None
            and not (selection.quick or selection.patterns or selection.solvers or selection.files)):
        exitstatus = 0
    if not options.list and exitstatus == 0:
        npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
        checks = {
            "catalog": ([sys.executable, "-m", "pytest", "tests", "-q"], repo / "app/catalog"),
            "docs": ([npm, "run", "check:docs"], repo / "app/ui"),
            "examples": ([npm, "run", "test:catalog-examples"], repo / "app/ui"),
            "ui": ([npm, "run", "check"], repo / "app/ui"),
        }
        for action in actions:
            command, cwd = checks[action]
            started = perf_counter()
            environment = {key: value for key, value in os.environ.items() if key != "CAEMBLE_TEST_RUN_DIR"}
            result = subprocess.run(command, cwd=cwd, env=environment)
            records.append({"check": action, "exitStatus": result.returncode, "duration": perf_counter() - started})
            (root / "checks.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
            if result.returncode:
                exitstatus = result.returncode
                break
    summary_path = root / "summary.json"
    if summary_path.exists():
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        summary.update(runExitStatus=exitstatus, totalElapsed=perf_counter() - run_started,
                       checks=records, targets=options.tests or ["tests"])
        summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"Report: {summary_path}", flush=True)
    return exitstatus


if __name__ == "__main__":
    raise SystemExit(main())
