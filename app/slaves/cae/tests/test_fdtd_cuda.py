from __future__ import annotations

import numpy as np
import pytest
import torch

from app.solvers.fdtd.v1_0_0.materials import build_update_coefficients
from app.solvers.fdtd.v1_0_0.physics import FDTDEngine
from app.solvers.fdtd.v1_0_0.pml import CpmlState


@pytest.mark.cuda
@pytest.mark.skipif(not torch.cuda.is_available(), reason="CUDA device is unavailable")
@pytest.mark.parametrize("model", [1, 2], ids=["drude-rc", "drude-trc"])
def test_cuda_fdtd_with_cpml_matches_cpu(model: int) -> None:
    shape = (2, 2, 32)
    dt = 1e-17
    initial = np.random.default_rng(42).standard_normal((3, *shape)).astype(np.float32) * 1e-3
    results = []
    for device_name in ("cpu", "cuda"):
        device = torch.device(device_name)
        coefficients = build_update_coefficients(
            np.full(shape, 2.0, np.float32), np.ones(shape, np.float32),
            np.full(shape, 1e14, np.float32), np.full(shape, 1e12, np.float32),
            np.full(shape, model, np.uint8), dt, (False, True, True), device,
        )
        widths = tuple(torch.full((count,), 1e-8, device=device) for count in (32, 2, 2))
        cpml = CpmlState(shape, ((4, 4), (0, 0), (0, 0)), dt, 3e-7, device)
        engine = FDTDEngine(widths, (False, True, True), dt, coefficients, cpml)
        engine.electric.copy_(torch.from_numpy(initial).to(device))
        for _ in range(40):
            engine.step_magnetic()
            engine.step_electric()
        assert engine.electric.device.type == device_name
        assert torch.isfinite(engine.electric).all().item()
        results.append((engine.electric.cpu(), engine.magnetic.cpu()))
    for cpu, cuda in zip(*results, strict=True):
        # Compare field energy scales: individual samples can cross zero after
        # propagation, where a pointwise relative error is not informative.
        relative_error = torch.linalg.vector_norm(cuda - cpu) / torch.linalg.vector_norm(cpu)
        assert relative_error.item() < 1e-5
