"""Test-only CUDA selection inside a real ABI-3 child; public config is unchanged."""
import os


def cuda_fdtd_child(request_connection, result_connection, cancellation_event):
    import torch
    from tests.solver_observer import install
    install()
    from app.kernel.execution.child import child_main
    from app.solvers.fdtd import entry, formulation

    formulation.select_device = lambda total_cells, estimated_bytes: torch.device("cuda")
    original_run, original_propagate = entry.implementation.run, entry.propagate

    async def run(invocation):
        await invocation.progress({"stage": "cuda-child", "pid": os.getpid(),
                                   "workspace": invocation.resources.workspace_path})
        return await original_run(invocation)

    async def propagate(engine, sources, time_detectors, spectral_detectors, step_count, progress, cancellation):
        torch.cuda.synchronize()
        await progress({"stage": "cuda-ready", "pid": os.getpid(),
                        "allocatedBytes": torch.cuda.memory_allocated()})
        await original_propagate(engine, sources, time_detectors, spectral_detectors, step_count, progress, cancellation)

    object.__setattr__(entry.implementation, "run", run)
    entry.propagate = propagate
    child_main(request_connection, result_connection, cancellation_event)
