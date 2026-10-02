"""Explicit 1/2/4/8 CPU measurements; never included in ordinary regression runs.

Run from CAE: python -m tests.cpu_benchmark --report <new-directory>
Each case runs fresh in its own process; only its CLI input build is shared.
"""
import argparse
import asyncio
import json
from pathlib import Path
import platform
import re
import subprocess
import sys
import time

import psutil

from app.kernel.execution import SpawnSolverExecutor
from app.kernel.execution.cpu import cpu_allocation


async def measure_case(options):
    from tests.catalog_build import CatalogBuilds
    from tests.fdtd_fixtures import small_fdtd_invocation
    from tests.ray_parallel_fixtures import continuous_ray_invocation

    prepared_at = time.perf_counter()
    if options.case == "ray":
        builds = CatalogBuilds(options.report / "builds", Path(__file__).resolve().parents[4])
        invocation = continuous_ray_invocation(builds)
        locator = "app.solvers.ray_tracing.entry:implementation"
    else:
        invocation = small_fdtd_invocation()
        locator = "app.solvers.fdtd.entry:implementation"
    preparation = time.perf_counter() - prepared_at
    events = []
    executor = SpawnSolverExecutor(cpu_budget=options.cpu)
    started = time.perf_counter()
    result = await executor.execute(locator, invocation, progress=events.append, timeout=180)
    elapsed = time.perf_counter() - started
    await executor.wait_for_cleanup()
    stages = {event["stage"]: event for event in events if "stage" in event}
    print(json.dumps({"case": options.case, "cpuBudget": executor.cpu.budget,
                      "inputPreparationSeconds": preparation, "executionSeconds": elapsed,
                      "observations": dict(result.observations), "stages": stages,
                      "residualChildren": [child.pid for child in psutil.Process().children(recursive=True)]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--case", choices=("ray", "fdtd"), help=argparse.SUPPRESS)
    parser.add_argument("--cpu", type=int, help=argparse.SUPPRESS)
    options = parser.parse_args()
    options.report = options.report.resolve()
    if options.case:
        asyncio.run(measure_case(options))
        return
    options.report.mkdir(parents=True, exist_ok=False)
    available = cpu_allocation().available
    budgets = [count for count in (1, 2, 4, 8) if count <= available]
    summary = {"platform": platform.platform(), "python": sys.version, "availableCpus": available,
               "skippedBudgets": [count for count in (1, 2, 4, 8) if count > available],
               "memoryMetric": "sampled peak sum of RSS in the complete case process tree (25 ms interval)",
               "cases": []}
    for case in ("ray", "fdtd"):
        for budget in budgets:
            stdout = options.report / f"{case}-{budget}.json"
            stderr = options.report / f"{case}-{budget}.log"
            with stdout.open("w", encoding="utf-8") as output, stderr.open("w", encoding="utf-8") as logs:
                started = time.perf_counter()
                process = subprocess.Popen([sys.executable, "-m", "tests.cpu_benchmark", "--report", str(options.report),
                                            "--case", case, "--cpu", str(budget)], stdout=output, stderr=logs)
                peak = 0
                cpu_times = {}
                while process.poll() is None:
                    rss = 0
                    try:
                        root = psutil.Process(process.pid)
                        children = [root, *root.children(recursive=True)]
                    except psutil.Error:
                        children = []
                    for child in children:
                        try:
                            rss += child.memory_info().rss
                            timing = child.cpu_times()
                            cpu_times[(child.pid, child.create_time())] = timing.user + timing.system
                        except psutil.Error:
                            pass
                    peak = max(peak, rss)
                    time.sleep(.025)
                wall = time.perf_counter() - started
            if process.returncode:
                raise RuntimeError(f"benchmark failed: {stderr}")
            result = json.loads(stdout.read_text(encoding="utf-8"))
            log_text = stderr.read_text(encoding="utf-8")
            result.update(totalSeconds=wall, peakRssBytes=peak, sampledCpuSeconds=sum(cpu_times.values()))
            result["runtimeTimings"] = [line for line in log_text.splitlines()
                                        if re.search(r"duration_ms=|solver batch setup|solver batches|Torch threads", line)]
            summary["cases"].append(result)
            (options.report / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
            print(f"{case} CPU={budget}: execution={result['executionSeconds']:.3f}s peakRSS={peak / 2**20:.1f}MiB", flush=True)


if __name__ == "__main__":
    main()
