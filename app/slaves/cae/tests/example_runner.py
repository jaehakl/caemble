"""Run fresh nominal Catalog examples, measuring input build through resource cleanup."""

import asyncio
import ctypes
from hashlib import sha256
from importlib.metadata import PackageNotFoundError, version
import json
import os
from pathlib import Path
import platform
import subprocess
from time import perf_counter
import traceback


def physical_memory_bytes():
    if os.name == "nt":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong),
                        *[(name, ctypes.c_ulonglong) for name in (
                            "totalPhysical", "availablePhysical", "totalPage", "availablePage",
                            "totalVirtual", "availableVirtual", "availableExtended")]]

        status = MemoryStatus()
        status.length = ctypes.sizeof(status)
        return status.totalPhysical if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)) else None
    try:
        return os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (AttributeError, OSError, ValueError):
        return None


def processor_name():
    if os.name == "nt":
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
                return winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
        except OSError:
            pass
    return platform.processor()


def code_identity(repo, builds):
    digest = sha256()
    cae = repo / "app/slaves/cae"
    for path in sorted([*(cae / "app").rglob("*.py"), *(cae / "tests").rglob("*.py")]):
        digest.update(path.relative_to(cae).as_posix().encode("utf-8") + b"\0")
        digest.update(path.read_bytes())
    revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True)
    return {"gitHead": revision.stdout.strip(), "caePythonSha256": digest.hexdigest(), "cliSha256": builds.cli_hash}


def run_examples(keys, root, repo):
    from caemble_catalog import open_catalog
    from app.kernel.coordinator.run import DEFAULT_MAX_RUN_SECONDS
    from tests.catalog_build import CatalogBuilds
    from tests.catalog_example_fixtures import run_catalog_example
    from tests.cli_build_observer import install as observe_cli_builds, summarize as summarize_cli_builds
    from tests.solver_observer import install, summarize

    os.environ["CAEMBLE_TEST_TIER"] = "example"
    os.environ["CAEMBLE_SOLVER_EVENTS_DIR"] = str(root / "solver-events")
    os.environ["CAEMBLE_CLI_BUILD_EVENTS_DIR"] = str(root / "cli-build-events")
    install()
    observe_cli_builds()
    builds = CatalogBuilds(root / "builds", repo)
    versions = {}
    for package in ("numpy", "scipy", "netgen-mesher", "manifold3d", "torch"):
        try:
            versions[package] = version(package)
        except PackageNotFoundError:
            versions[package] = None
    with open_catalog() as catalog:
        catalog_revision = catalog.meta()["catalogRevision"]
    environment = {"platform": platform.platform(), "processor": processor_name(),
                   "logicalCpuCount": os.cpu_count(), "python": platform.python_version(),
                   "physicalMemoryBytes": physical_memory_bytes(), "workers": 1, "libraryVersions": versions,
                   "threadLimits": {name: os.environ.get(name) for name in
                                    ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "BLIS_NUM_THREADS", "NUMEXPR_NUM_THREADS")},
                   "scope": "fresh nominal input build, geometry/mesh, all solvers, outputs, ACK and cleanup",
                   "budgetSeconds": 180, "designTargetSeconds": 90,
                   "catalogRevision": catalog_revision, "codeIdentity": code_identity(repo, builds)}
    (root / "environment.json").write_text(json.dumps(environment, indent=2), encoding="utf-8")
    results = []
    for key in keys:
        print(f"Example {key}: fresh nominal input and complete run (180 s budget)", flush=True)
        os.environ["CAEMBLE_CURRENT_TEST"] = f"example:{key}"
        started = perf_counter()
        record = {"key": key, "phases": {}}
        try:
            build_started = perf_counter()
            try:
                measurement = builds[key]
            finally:
                record["phases"]["inputBuild"] = perf_counter() - build_started
            remaining = 180 - (perf_counter() - started)
            if remaining <= 0:
                raise TimeoutError("nominal input build exhausted the 180 s example budget")
            # This deadline belongs only to the example benchmark. wait_for waits
            # for cooperative cancellation and the harness's close/finally path.
            record.update(asyncio.run(asyncio.wait_for(
                run_catalog_example(measurement, key, run_timeout=DEFAULT_MAX_RUN_SECONDS, timings=record["phases"]),
                timeout=remaining)),
                          outcome="passed")
        except TimeoutError:
            record.update(outcome="failed", error="example exceeded its 180 s benchmark budget; cleanup completed")
        except Exception as error:
            record.update(outcome="failed", error=f"{type(error).__name__}: {error}", traceback=traceback.format_exc())
        record["duration"] = perf_counter() - started
        record["withinBudget"] = record["duration"] <= 180
        observed = summarize(root / "solver-events")
        calls = [call for call in observed["calls"] if call["test"] == f"example:{key}"]
        unfinished = [call for call in observed["unfinished"] if call["test"] == f"example:{key}"]
        record["productSolvers"] = {"count": len(calls) + len(unfinished),
                                    "duration": sum(call["duration"] for call in calls), "unfinished": unfinished}
        results.append(record)
        print(f"Example {key}: {record['outcome']}, {record['duration']:.2f} s, within budget={record['withinBudget']}", flush=True)
        (root / "examples.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    status = 0 if all(item["outcome"] == "passed" and item["withinBudget"] for item in results) else 1
    shared_builds = len(list((root / "builds").glob("*/complete.json")))
    summary = {"suite": "examples", "runExitStatus": status, "selected": len(keys),
               "examples": results, "environment": environment,
               "buildCount": shared_builds, "sharedInputBuildCount": shared_builds,
               "cliBuilds": summarize_cli_builds(root / "cli-build-events"),
               "productSolvers": summarize(root / "solver-events")}
    (root / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return status
