from __future__ import annotations

import pytest

from app.solvers.fdtd.v1_0_0 import formulation


def test_select_device_uses_cpu_below_cell_cutoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(formulation.torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(
        formulation.torch.cuda,
        "mem_get_info",
        lambda: pytest.fail("VRAM must not be queried below the device cutoff"),
    )

    device = formulation.select_device(99_999, estimated_bytes=2**50)

    assert device.type == "cpu"


def test_select_device_uses_cuda_at_cell_cutoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    required_bytes = 1_000_000
    monkeypatch.setattr(formulation.torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(
        formulation.torch.cuda,
        "mem_get_info",
        lambda: (required_bytes, required_bytes * 2),
    )

    device = formulation.select_device(100_000, estimated_bytes=required_bytes)

    assert device.type == "cuda"


def test_select_device_uses_cpu_when_cuda_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(formulation.torch.cuda, "is_available", lambda: False)
    monkeypatch.setattr(
        formulation.torch.cuda,
        "mem_get_info",
        lambda: pytest.fail("VRAM must not be queried when CUDA is unavailable"),
    )

    device = formulation.select_device(100_000, estimated_bytes=2**50)

    assert device.type == "cpu"


def test_select_device_fails_preflight_without_cpu_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    required_bytes = 1_000_000
    monkeypatch.setattr(formulation.torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(
        formulation.torch.cuda,
        "mem_get_info",
        lambda: (required_bytes - 1, required_bytes * 2),
    )

    with pytest.raises(MemoryError, match="CPU fallback is disabled"):
        formulation.select_device(100_000, estimated_bytes=required_bytes)


def test_estimate_device_bytes_includes_cpml_and_spectral_accumulation() -> None:
    shape = (10, 20, 30)
    pml_cells = ((2, 3), (4, 5), (6, 7))
    spectral_elements = 1_234
    cell_count = 10 * 20 * 30
    cpml_elements = 4 * (
        (2 + 3) * 20 * 30
        + (4 + 5) * 10 * 30
        + (6 + 7) * 10 * 20
    )

    estimated = formulation.estimate_device_bytes(
        shape,
        pml_cells,
        spectral_elements,
    )

    assert estimated == 4 * (44 * cell_count + cpml_elements) + 8 * spectral_elements

