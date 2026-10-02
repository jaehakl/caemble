import math

import pytest
from pydantic import ValidationError

from app.resources import ResourcePolicy
from sdk.protocol.execution import ResourceAllocation, ResourceRequest, gib_to_bytes


@pytest.mark.parametrize("value,bytes", [(12, 12 * 1024**3), (0.5, 512 * 1024**2), (0.1, 107374183)])
def test_gib_conversion_and_resource_inputs(value, bytes):
    assert gib_to_bytes(value) == bytes
    assert ResourcePolicy(ram_budget_gb=value).ram_budget_gb == value
    assert ResourceRequest(vram_budget_gb=value).vram_budget_gb == value


@pytest.mark.parametrize("value", [0, -1, True, "12", math.inf, math.nan, 2**53])
def test_invalid_budgets_are_rejected(value):
    with pytest.raises((ValueError, OverflowError)):
        gib_to_bytes(value)
    with pytest.raises(ValidationError):
        ResourceRequest(vram_budget_gb=value)
    with pytest.raises(ValidationError):
        ResourcePolicy(ram_budget_gb=value)


def test_legacy_inputs_have_actionable_errors():
    with pytest.raises(ValidationError, match="ram_budget_gb"):
        ResourcePolicy(ram_budget_bytes=1024**3)
    with pytest.raises(ValidationError, match="vram_budget_gb"):
        ResourceRequest(gpu_memory_bytes=1024**3)
    with pytest.raises(ValidationError, match="vram_budget_gb"):
        ResourcePolicy(defaults={"ai": {"gpu_memory_bytes": 1024**3}})
    with pytest.raises(ValidationError, match="CPU-only"):
        ResourceRequest(gpu_count=0, vram_budget_gb=1)


def test_allocation_budgets_cover_exact_devices():
    allocation = dict(cpu_ids=[0], cpu_cores=1, startup_ram_bytes=1, ram_available_bytes=1,
                      gpu_devices=["GPU-a", "GPU-b"], vram_budget_bytes={"GPU-a": 12 * 1024**3, "GPU-b": 6 * 1024**3})
    assert len(ResourceAllocation(**allocation).vram_budget_bytes) == 2
    for budgets in ({"GPU-a": 1}, {"GPU-a": 1, "GPU-b": True}, {"GPU-a": 1, "GPU-b": 0}):
        with pytest.raises(ValidationError):
            ResourceAllocation(**{**allocation, "vram_budget_bytes": budgets})
