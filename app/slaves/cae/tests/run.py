"""Run low-cost checks by default; choose product smoke, validation or examples explicitly."""

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

from tests.selection import changed_paths, collection_targets, excluded_function_targets, select_changes


THREAD_LIMITS = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "BLIS_NUM_THREADS", "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS")
ALL_TIERS = {"lowcost", "smoke", "validation", "example"}


def main(argv=None):
    run_started = perf_counter()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("suite", nargs="?", choices=("affected", "quick", "full", "examples"), default="affected")
    parser.add_argument("--base", default="HEAD", help="Git revision compared with staged/unstaged/untracked files")
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--list", action="store_true", help="Explain selections without running checks")
    parser.add_argument("--report", type=Path, help="New empty report directory; defaults to .work/cae-tests/<run>")
    parser.add_argument("--tests", nargs="+", help="Registered CAE test files/node IDs, limited by the requested cost tiers")
    parser.add_argument("--smoke", action="store_true", help="Include affected product and process integration checks")
    parser.add_argument("--validation", action="store_true", help="Include affected numerical validation")
    parser.add_argument("--key", action="append", help="Catalog example key (repeat to select several; '*' selects all)")
    options = parser.parse_args(argv)
    if options.jobs < 1:
        parser.error("--jobs must be positive")
    if options.suite == "examples" and (options.tests or options.smoke or options.validation or not options.key):
        parser.error("examples requires --key and cannot be combined with --tests/--smoke/--validation")
    if options.key and options.suite != "examples":
        parser.error("--key is only valid for examples")
    cae = Path(__file__).resolve().parents[1]
    repo = cae.parents[2]
    root = (options.report or repo / ".work/cae-tests" / (datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + uuid4().hex[:8])).resolve()
    if root.exists() and any(root.iterdir()):
        parser.error("--report must be a new or empty directory")
    selection = None
    try:
        if options.suite == "affected" and not options.tests:
            selection = select_changes(changed_paths(repo, options.base))
        allowed = (ALL_TIERS.copy() if options.suite == "full" else {"example"} if options.suite == "examples" else
                   {"lowcost"} | ({"smoke"} if options.smoke else set()) | ({"validation"} if options.validation else set()))
        if options.suite == "examples":
            from caemble_catalog import CatalogError, open_catalog

            try:
                with open_catalog() as catalog:
                    rows, _ = catalog.list_experiments(limit=10000)
                    available = {row["key"] for row in rows}
                    keys = sorted(available) if "*" in options.key else list(dict.fromkeys(options.key))
                    for key in keys:
                        catalog.experiment(key, include_bundle=False)
            except CatalogError as error:
                raise ValueError(str(error)) from error
            targets, excluded = [], {}
        else:
            targets, excluded = collection_targets(selection, allowed)
            if options.tests:
                from tests.tiers import MODULE_TIERS, module_candidates, test_tier

                candidates = set(module_candidates(allowed))
                targets, excluded = [], {}
                for target in options.tests:
                    parts = target.split("::", 1)
                    resolved = Path(parts[0]).resolve()
                    try:
                        filename = resolved.relative_to(cae).as_posix()
                    except ValueError:
                        filename = resolved.as_posix()
                    normalized = filename + ("::" + parts[1] if len(parts) == 2 else "")
                    if filename not in MODULE_TIERS:
                        raise ValueError(f"--tests requires a registered CAE test file, not a directory or external path: {parts[0]}")
                    tier = test_tier(normalized) if filename in MODULE_TIERS and len(parts) == 2 else None
                    if filename in MODULE_TIERS and (filename not in candidates or (tier and tier not in allowed)):
                        required = tier or MODULE_TIERS[filename]
                        flag = "examples --key <key> or full" if required == "example" else f"--{required}"
                        excluded[normalized] = f"requires {flag}"
                    else:
                        targets.append(normalized)
                if excluded:
                    raise ValueError("Explicit targets exceed the requested cost tiers:\n" +
                                     "\n".join(f"{target}: {reason}" for target, reason in excluded.items()))
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        parser.error(str(error))
    excluded_functions = excluded_function_targets(targets, selection, allowed)
    root.mkdir(parents=True, exist_ok=True)
    temporary = root / "tmp"
    temporary.mkdir()
    for name in THREAD_LIMITS:
        os.environ[name] = "1"
    os.environ["CAEMBLE_CAE_CPU_BUDGET"] = "1"
    for name in ("TMPDIR", "TEMP", "TMP"):
        os.environ[name] = str(temporary)
    os.environ["CAEMBLE_TEST_RUN_DIR"] = str(root)
    os.chdir(cae)
    import tempfile

    tempfile.tempdir = str(temporary)
    actions = ([] if options.tests or options.suite == "examples" else sorted(selection.actions) if selection else
               ["python-static"] if options.suite in {"quick", "full"} else [])
    actions.sort(key=lambda action: (action != "python-static", action != "ui-static", action))
    arguments = [*targets, "-m", "not cuda", "-p", "tests.reporting",
                 f"--cae-suite={options.suite}", f"--cae-report={root}", f"--cae-tiers={','.join(sorted(allowed))}",
                 "--durations=25", "--durations-min=1", "--tb=short"]
    if options.tests:
        arguments.append("--cae-explicit")
    if selection:
        payload = {key: sorted(value) if isinstance(value, set) else value for key, value in asdict(selection).items()}
        selected = root / "selection.json"
        selected.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        arguments.append(f"--cae-selection={selected}")
        for path, reason in {**selection.reasons, **selection.ignored}.items():
            print(f"{path}: {reason}", flush=True)
    if options.list:
        arguments.extend(("--collect-only", "-q", "-n", "0"))
    elif options.jobs > 1:
        arguments.extend(("-n", str(options.jobs), "--dist", "worksteal", "-q"))
    else:
        arguments.extend(("-n", "0", "-q"))
    workers = 1 if options.list or options.suite == "examples" else options.jobs
    print(f"CAE {options.suite}; tiers={','.join(sorted(allowed))}; workers={workers}; report={root}", flush=True)
    print("Additional checks: " + (", ".join(actions) or "none"), flush=True)
    for target, reason in excluded.items():
        print(f"Excluded {target}: {reason}", flush=True)
    for target, reason in excluded_functions.items():
        print(f"Excluded {target}: {reason}", flush=True)
    invocation = {"arguments": arguments, "actions": actions, "excludedRelated": excluded,
                  "excludedRelatedFunctions": excluded_functions,
                  "base": options.base, "jobs": workers, "tiers": sorted(allowed),
                  "threadLimits": dict.fromkeys(THREAD_LIMITS, "1")}
    (root / "invocation.json").write_text(json.dumps(invocation, indent=2), encoding="utf-8")
    if options.suite == "examples":
        if options.list:
            print("Examples: " + ", ".join(keys), flush=True)
            (root / "summary.json").write_text(json.dumps({"suite": "examples", "collectionOnly": True,
                "selected": len(keys), "keys": keys, "productSolvers": {"count": 0, "duration": 0}}, indent=2), encoding="utf-8")
            return 0
        from tests.example_runner import run_examples

        return run_examples(keys, root, repo)
    records = []
    exitstatus = 0
    if not options.list:
        npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
        checks = {
            "python-static": [([sys.executable, "-m", "ruff", "check", "app", "tests"], cae),
                              ([sys.executable, "-m", "pyright"], cae)],
            "catalog": [([sys.executable, "-m", "pytest", "tests", "-q"], repo / "app/catalog")],
            "docs": [([npm, "run", "check:docs"], repo / "app/ui")],
            "examples": [([npm, "run", "test:catalog-examples", "--", "--report", str(root / "catalog-example-builds.json")], repo / "app/ui")],
            "ui-static": [([npm, "run", "check:static"], repo / "app/ui")],
        }
        for action in actions:
            for command, cwd in checks[action]:
                started = perf_counter()
                environment = {key: value for key, value in os.environ.items() if key != "CAEMBLE_TEST_RUN_DIR"}
                result = subprocess.run(command, cwd=cwd, env=environment)
                records.append({"check": action, "command": command, "exitStatus": result.returncode,
                                "duration": perf_counter() - started})
                build_report = root / "catalog-example-builds.json"
                if action == "examples" and build_report.exists():
                    records[-1]["inputBuilds"] = json.loads(build_report.read_text(encoding="utf-8"))
                (root / "checks.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
                if result.returncode:
                    exitstatus = result.returncode
                    break
            if exitstatus:
                break
    if targets and exitstatus == 0:
        import pytest

        exitstatus = int(pytest.main(arguments))
        if exitstatus == pytest.ExitCode.NO_TESTS_COLLECTED and not options.tests:
            exitstatus = 0
    else:
        from tests.reporting import ProgressReport

        report = ProgressReport(root, options.suite)
        report.finish(exitstatus, options.list)
    summary_path = root / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary.update(runExitStatus=exitstatus, totalElapsed=perf_counter() - run_started,
                   checks=records, targets=targets, tiers=sorted(allowed), excludedRelated=excluded,
                   excludedRelatedFunctions=excluded_functions)
    summary["authoringBuildCount"] = sum(check.get("inputBuilds", {}).get("buildCount", 0) for check in records)
    summary["catalogBuildCountTotal"] = summary["cliBuilds"]["succeeded"] + summary["authoringBuildCount"]
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"Report: {summary_path}", flush=True)
    return exitstatus


if __name__ == "__main__":
    raise SystemExit(main())
