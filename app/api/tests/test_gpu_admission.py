"""API and Hybrid use the same whole-lifetime GPU budgets as the launcher."""
import pytest

from gpstation.service.execution import gpu_resources_fit, resource_fits
from optimization.predictor_jobs import resources_fit_together, resources_from_frozen_hybrid

GIB = 1024**3


def test_frozen_hybrid_profiles_remain_immutable_when_creating_v3_requests():
    legacy = {"predictor": {"gpu_count": 1, "gpu_memory_bytes": GIB//2},
              "evaluation": {"gpu_count": 0, "gpu_memory_bytes": 0}}
    assert resources_from_frozen_hybrid(legacy) == {
        "predictor": {"gpu_count": 1, "vram_budget_gb": 0.5}, "evaluation": {"gpu_count": 0}}
    assert legacy["predictor"]["gpu_memory_bytes"] == GIB//2


def report(*, reserved=18, free=20, admission_open=True):
    return {"admission_open": True, "cpu_total": 8, "cpu_reserved": 0,
            "ram_budget_bytes": 10000, "gpu_devices": [
                {"uuid": "GPU-a", "total_bytes": 24*GIB, "free_bytes": free*GIB,
                 "vram_reserved_bytes": reserved*GIB, "admission_open": admission_open}]}


@pytest.mark.parametrize("budget,expected", [(6, True), (7, False), (0.5, True)])
def test_12_plus_6_reservation_admits_6_not_7(budget, expected):
    assert resource_fits({"gpu_count": 1, "vram_budget_gb": budget}, report(), "ai") is expected


def test_full_device_default_and_live_measurement_guards():
    assert resource_fits({"gpu_count": 1}, report(reserved=0), "ai")
    assert not resource_fits({"gpu_count": 1}, report(), "ai")
    for value in (report(free=0), report(admission_open=False), report(reserved=24)):
        assert not resource_fits({"gpu_count": 1, "vram_budget_gb": 1}, value, "ai")
        assert resource_fits({"gpu_count": 0}, value, "cae")


def test_old_telemetry_cannot_admit_budgeted_gpu_requests():
    value = report(reserved=0)
    del value["gpu_devices"][0]["vram_reserved_bytes"]
    assert not resource_fits({"gpu_count": 1}, value, "ai")


def test_hybrid_reserves_both_jobs_and_requires_distinct_devices_within_each_job():
    resources = {"parent": {"gpu_count": 1, "vram_budget_gb": 12},
                 "child": {"gpu_count": 1, "vram_budget_gb": 6}}
    assert resources_fit_together(resources, report(reserved=6), available=True)
    assert not resources_fit_together(resources, report(reserved=7), available=True)
    assert resources_fit_together(resources, report(reserved=24, admission_open=False))
    assert not gpu_resources_fit([{"gpu_count": 2, "vram_budget_gb": 6}], report(reserved=0))
    assert gpu_resources_fit([{"gpu_count": 1, "vram_budget_gb": 6}]*4, report(reserved=0))
    assert not gpu_resources_fit([{"gpu_count": 1, "vram_budget_gb": 6}]*5, report(reserved=0))


def test_multi_gpu_preflight_backtracks_to_a_valid_placement():
    value = report(reserved=0)
    value["gpu_devices"] += [
        {**value["gpu_devices"][0], "uuid": "GPU-b", "vram_reserved_bytes": 12*GIB},
        {**value["gpu_devices"][0], "uuid": "GPU-c", "vram_reserved_bytes": 18*GIB}]
    assert gpu_resources_fit([{"gpu_count": 2, "vram_budget_gb": 6},
                              {"gpu_count": 1, "vram_budget_gb": 24}], value)
