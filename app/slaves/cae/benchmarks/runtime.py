"""Measure coordinator overhead, mmap transfer, and explicit state retention.

Run this same file against both package snapshots. Solver execution is mocked;
these timings do not measure child startup or numerical Solver performance.
"""
from __future__ import annotations

import argparse
import asyncio
import gc
import importlib.util
import json
import platform
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--release-previous", action="store_true")
    parser.add_argument("--array-mib", type=int, default=4)
    parser.add_argument("--iterations", type=int, default=24)
    parser.add_argument("--repeats", type=int, default=7)
    parser.add_argument("--calls-per-repeat", type=int, default=200)
    parser.add_argument("--transfers-per-repeat", type=int, default=10)
    args = parser.parse_args()
    package_root = args.package_root.resolve()
    sys.path.insert(0, str(package_root))

    import numpy as np

    import app.runtime_kernel.coordinator.simulation as simulation_module
    from app.runtime_kernel.api import SolverResult
    from app.runtime_kernel.execution import MmapPayloadCodec, SolverExecutionTransaction
    from app.runtime_kernel.resources import BufferStore, ResourceStore, StatePatch, StateStore

    if args.release_previous and not hasattr(StateStore, "release"):
        parser.error("the selected snapshot does not implement explicit state release")
    spec = importlib.util.spec_from_file_location(
        "cae_benchmark_fixture", package_root / "tests" / "test_simulation_coordinator.py"
    )
    fixture = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = fixture
    spec.loader.exec_module(fixture)
    item_count = args.array_mib * 1024 * 1024 // np.dtype(np.float64).itemsize
    output = {
        "package_root": str(package_root),
        "started_at": datetime.now(timezone.utc).isoformat(),
        "python": sys.version.split()[0],
        "numpy": np.__version__,
        "platform": platform.platform(),
        "array_bytes": item_count * np.dtype(np.float64).itemsize,
        "repeats": args.repeats,
        "calls_per_repeat": args.calls_per_repeat,
        "transfers_per_repeat": args.transfers_per_repeat,
        "retention_iterations": args.iterations,
        "release_previous": args.release_previous,
        "timing_scope": "mocked sim.run includes validation/commit; transfer includes materialize/encode/decode; cleanup excluded",
    }

    tiny_output = np.ones(1, dtype=np.float64)

    async def invoke(*unused_args, **unused_kwargs):
        return SolverExecutionTransaction(SolverResult(artifacts={"field": {"value": tiny_output}}))

    original = simulation_module.run_kernel_transaction
    simulation_module.run_kernel_transaction = invoke
    run = fixture.FakeRun()
    simulation = simulation_module.SimulationApi(run)
    batch_means = []
    try:
        for _ in range(10):
            result = await simulation.run(run.producer)
            simulation.release(result["artifacts"])
        for _ in range(args.repeats):
            run.trace.clear()
            elapsed = 0
            for _ in range(args.calls_per_repeat):
                started = time.perf_counter_ns()
                result = await simulation.run(run.producer)
                elapsed += time.perf_counter_ns() - started
                simulation.release(result["artifacts"])
            batch_means.append(elapsed / args.calls_per_repeat / 1000)
        output["mocked_sim_run_us"] = {
            "median_batch_mean": statistics.median(batch_means),
            "batch_means": batch_means,
        }
    finally:
        simulation.close()
        simulation_module.run_kernel_transaction = original

    for reuse_mmap in (False, True):
        with BufferStore() as buffers:
            resources = ResourceStore()
            states = StateStore(resources)
            codec = MmapPayloadCodec(buffers)
            try:
                source = np.arange(item_count, dtype=np.float64)
                if reuse_mmap:
                    seed = codec.begin_invocation()
                    source = seed.decode(seed.encode(source))
                state = states.replace(None, {"values": source}, copy_arrays=False)
                if reuse_mmap:
                    seed.commit()
                del source
                gc.collect()
                batch_means = []
                materialize_means = []
                payload_bytes = 0
                for repeat in range(args.repeats + 1):
                    elapsed = 0
                    materialize_elapsed = 0
                    for _ in range(args.transfers_per_repeat):
                        invocation = codec.begin_invocation()
                        started = time.perf_counter_ns()
                        materialized = state.to_mutable()
                        after_materialize = time.perf_counter_ns()
                        payload = invocation.encode(materialized)
                        transferred = invocation.decode(payload)
                        finished = time.perf_counter_ns()
                        elapsed += finished - started
                        materialize_elapsed += after_materialize - started
                        payload_bytes = len(payload)
                        assert transferred["values"][0] == 0.0
                        assert transferred["values"][-1] == item_count - 1
                        del transferred, materialized
                        invocation.commit()
                        gc.collect()
                        assert len(buffers.files()) == int(reuse_mmap)
                    if repeat:
                        batch_means.append(elapsed / args.transfers_per_repeat / 1_000_000)
                        materialize_means.append(materialize_elapsed / args.transfers_per_repeat / 1000)
                output["reuse_mmap_transfer" if reuse_mmap else "publish_array_transfer"] = {
                    "median_batch_mean_ms": statistics.median(batch_means),
                    "batch_means_ms": batch_means,
                    "median_materialize_us": statistics.median(materialize_means),
                    "serialized_payload_bytes": payload_bytes,
                    "retained_files": len(buffers.files()),
                }
            finally:
                states.close()
                resources.close()

    with BufferStore() as buffers:
        resources = ResourceStore()
        states = StateStore(resources)
        codec = MmapPayloadCodec(buffers)
        current = states.empty
        checkpoint = None
        history = []
        try:
            for step in range(args.iterations):
                invocation = codec.begin_invocation()
                values = invocation.decode(
                    invocation.encode(np.full(item_count, step, dtype=np.float64))
                )
                previous = current
                current = states.commit(previous, StatePatch().put("values", values), copy_arrays=False)
                invocation.commit()
                del values
                history.append(previous)
                if checkpoint is None:
                    checkpoint = current
                if args.release_previous and previous.revision != checkpoint.revision:
                    states.release(previous)
            gc.collect()
            assert checkpoint["values"][0] == 0.0
            assert current["values"][0] == args.iterations - 1
            files = buffers.files()
            output["retained_state"] = {
                "revision_metadata_count": len(states.revisions()),
                "old_handle_count": len(history),
                "resource_node_count": resources.stats().resource_count,
                "mmap_file_count": len(files),
                "mmap_file_bytes": sum(path.stat().st_size for path in files),
                "policy": "current + first checkpoint" if args.release_previous else "all revisions",
            }
        finally:
            states.close()
            resources.close()
        gc.collect()
        output["retained_state"]["mmap_files_after_close"] = len(buffers.files())
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
