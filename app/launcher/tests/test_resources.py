import time

import pytest
from pydantic import ValidationError

from app.resources import GIB, ResourceLedger, ResourcePolicy


def ledger(ram=8 * GIB):
    value = ResourceLedger(ResourcePolicy(cpu_cores=12, ram_budget_bytes=ram,
        ram_growth_headroom_bytes=GIB, system_ram_headroom_bytes=GIB), cpu_ids=list(range(12)), total_ram=16 * GIB)
    value.sample({}, launcher_rss=0, available_ram=16 * GIB, gpus=[])
    return value


def test_concurrent_startup_allowances_prevent_zero_rss_ram_burst():
    value = ledger(3 * GIB)
    assert value.reserve("a", "cae", {"cpu_cores": 1})[0]
    assert value.reserve("b", "cae", {"cpu_cores": 1})[0]
    assert value.reserve("c", "cae", {"cpu_cores": 1}) == (None, "ram_pressure")
    assert len(value.reservations) == 2


def test_live_growth_only_pauses_admission_and_recovers_after_cleanup():
    value = ledger()
    value.reserve("a", "cae", {})
    value.reservations["a"].running = True
    for _ in range(2):
        value.sample({"a": 9 * GIB}, launcher_rss=0, available_ram=7 * GIB, gpus=[], now=value.sampled_at + 1)
    assert value.reservations["a"].running_samples == 2
    assert value.reserve("b", "cae", {}) == (None, "ram_pressure")
    assert "a" in value.reservations
    value.release("a")
    value.sample({}, launcher_rss=0, available_ram=16 * GIB, gpus=[])
    assert value.reserve("b", "cae", {})[0]


def test_stale_or_incomplete_measurements_never_become_zero_usage():
    value = ledger()
    value.sampled_at = time.monotonic() - 4
    assert value.reserve("a", "cae", {}) == (None, "metrics_stale")
    value.sample({}, launcher_rss=0, available_ram=16 * GIB, gpus=[], complete=False)
    assert value.reserve("a", "cae", {}) == (None, "metrics_stale")


def test_gpu_devices_are_exclusive_and_allocation_uses_uuids():
    value = ledger()
    value.sample({}, launcher_rss=0, available_ram=16 * GIB,
                 gpus=[{"uuid": "GPU-a", "total_bytes": 8 * GIB, "free_bytes": 7 * GIB}])
    request = {"gpu_count": 1, "gpu_memory_bytes": 6 * GIB}
    allocation, _ = value.reserve("a", "ai", request)
    assert allocation["gpu_devices"] == ["GPU-a"]
    assert value.reserve("b", "ai", request) == (None, "gpu_unavailable")
    value.release("a")
    assert value.reserve("b", "ai", request)[0]


def test_physical_free_memory_subtracts_unmaterialized_startups():
    value = ledger()
    value.sample({}, launcher_rss=0, available_ram=3 * GIB, gpus=[])
    assert value.reserve("a", "cae", {})[0]
    assert value.reserve("b", "cae", {}) == (None, "ram_pressure")


def test_handler_defaults_preserve_app_settings_and_requests_override():
    value = ledger()
    value.policy.defaults = {"cae": {"startup_ram_bytes": 2 * GIB, "cpu_cores": 2},
                             "cae.run": {"cpu_cores": 3}}
    allocation, _ = value.reserve("a", "cae", {"cpu_cores": 1}, "cae.run")
    assert allocation["cpu_cores"] == 1
    assert allocation["startup_ram_bytes"] == 2 * GIB
    assert value.report(["cae"])["defaults"]["cae.run"] == {"cpu_cores": 3}
    assert allocation["ram_available_bytes"] <= (value.ram_budget - value.growth_headroom) // 12


def test_cpu_only_request_clears_inherited_gpu_memory():
    value = ledger()
    value.policy.defaults = {"ai": {"gpu_count": 1, "gpu_memory_bytes": 4 * GIB}}
    allocation, reason = value.reserve("a", "ai", {"gpu_count": 0})
    assert reason is None and allocation["gpu_devices"] == []
    assert allocation["gpu_memory_bytes"] == 0


def test_repeated_timestamp_does_not_release_startup_allowance():
    value = ledger()
    value.reserve("a", "cae", {})
    value.reservations["a"].running = True
    stamp = value.sampled_at + 1
    for _ in range(2):
        value.sample({"a": 100}, launcher_rss=0, available_ram=16 * GIB, gpus=[], now=stamp)
    assert value.reservations["a"].running_samples == 1
    assert value.reservations["a"].unobserved_bytes == GIB - 100


def test_coarse_report_allows_explicit_smaller_startup_request():
    value = ledger(3 * GIB)
    value.sample({}, launcher_rss=GIB + GIB // 2, available_ram=16 * GIB, gpus=[])
    assert value.report(["cae"])["admission_open"]
    assert value.reserve("a", "cae", {"startup_ram_bytes": GIB // 4})[0]


@pytest.mark.parametrize("options", [
    {"sample_interval_seconds": 0}, {"metrics_max_age_seconds": 0},
    {"sample_interval_seconds": 4, "metrics_max_age_seconds": 3},
])
def test_invalid_observation_timing_rejected(options):
    with pytest.raises(ValidationError):
        ResourcePolicy(**options)


def test_configured_metrics_age_controls_report_and_admission():
    value = ledger()
    value.policy.sample_interval_seconds = 0.5
    value.policy.metrics_max_age_seconds = 1
    value.sampled_at = time.monotonic() - 2
    assert not value.report(["cae"])["admission_open"]
    assert value.reserve("a", "cae", {}) == (None, "metrics_stale")
    value.policy.metrics_max_age_seconds = 5
    assert value.report(["cae"])["admission_open"]
    assert value.reserve("a", "cae", {})[0]
