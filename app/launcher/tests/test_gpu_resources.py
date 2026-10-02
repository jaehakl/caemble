"""Observed VRAM admission, including sampling/transition races."""
from types import SimpleNamespace

import pytest

from app import resources
from app.resources import GIB, ResourceLedger, ResourcePolicy


@pytest.fixture
def gpu_ledger(monkeypatch):
    clock = SimpleNamespace(now=100.0)
    monkeypatch.setattr(resources, "time", SimpleNamespace(monotonic=lambda: clock.now))
    ledger = ResourceLedger(ResourcePolicy(cpu_cores=8, ram_budget_gb=16, defaults={"ai": {"vram_budget_gb": 6}}),
                            cpu_ids=list(range(8)), total_ram=64 * GIB)

    def sample(free=14 * GIB, *, devices=("GPU-a",), started_at=None, invalid=None):
        clock.now += 1
        gpus = [{"uuid": device, "total_bytes": 16 * GIB, "free_bytes": free} for device in devices]
        if invalid is not None:
            gpus = invalid
        ledger.sample({}, launcher_rss=0, available_ram=48 * GIB, gpus=gpus,
                      gpu_sample_started_at=started_at, gpu_process_metrics_complete=True)

    sample()
    return ledger, sample, clock


def test_default_gpu_and_explicit_cpu_profiles(gpu_ledger):
    ledger, sample, _ = gpu_ledger
    assert ledger.defaults("cae")["gpu_count"] == 1
    assert ledger.reserve("gpu", "cae", {"cpu_cores": 1})[0]["gpu_devices"] == ["GPU-a"]
    sample(devices=())
    assert ledger.reserve("wait", "cae", {"cpu_cores": 1})[0] is None
    assert ledger.reserve("cpu", "cae", {"cpu_cores": 1, "gpu_count": 0})[0]["gpu_devices"] == []
    ledger.policy.defaults = {"ai": {"gpu_count": 0}}
    assert ledger.defaults("ai")["gpu_count"] == 0
    assert ResourcePolicy(gpu_count=0).gpu_count == 0


@pytest.mark.parametrize("free,admitted", [(8 * GIB + 1, True), (8 * GIB, True), (1, True), (0, False)])
def test_live_free_memory_has_no_half_usage_cutoff(gpu_ledger, free, admitted):
    ledger, sample, _ = gpu_ledger
    sample(free)
    assert bool(ledger.reserve("a", "ai", {"cpu_cores": 1})[0]) is admitted


def test_sequential_observation_limit_and_cleanup_recovery(gpu_ledger):
    ledger, sample, _ = gpu_ledger
    request = {"cpu_cores": 1}
    first = ledger.reserve("a", "ai", request)[0]
    assert first and ledger.reserve("a", "ai", request)[0] is first
    for _ in range(4):
        sample()
    assert ledger.reserve("b", "ai", request)[0] is None  # Not running yet.
    ledger.mark_running("a")
    sample()  # Baseline after running.
    sample()
    assert ledger.reserve("b", "ai", request)[0] is None
    sample()
    assert ledger.reserve("b", "ai", request)[0]
    ledger.mark_running("b")
    for _ in range(3):
        sample()
    report = ledger.gpu_report()[0]
    assert report["instance_ids"] == ["a", "b"]
    assert report["job_count"] == 2
    assert report["vram_reserved_bytes"] == 12 * GIB
    assert report["admission_open"]
    assert ledger.reserve("c", "ai", request)[0] is None
    ledger.release("a")
    assert ledger.reserve("c", "ai", request)[0] is None
    for _ in range(3):
        sample()
    assert ledger.reserve("c", "ai", request)[0]


def test_growth_resets_observation_without_preempting(gpu_ledger):
    ledger, sample, _ = gpu_ledger
    ledger.reserve("a", "ai", {"cpu_cores": 1})
    ledger.mark_running("a")
    for _ in range(3):
        sample()
    assert ledger.gpu_report()[0]["admission_open"]
    sample(13 * GIB)
    assert ledger.gpu_report()[0]["waiting_reason"] == "gpu_observing"
    sample(0)
    assert ledger.gpu_report()[0]["waiting_reason"] == "gpu_memory_pressure"
    assert "a" in ledger.reservations
    sample(12 * GIB)
    sample(12 * GIB)
    assert ledger.reserve("b", "ai", {"cpu_cores": 1})[0]


def test_old_inflight_queries_and_duplicate_timestamps_do_not_count(gpu_ledger):
    ledger, sample, clock = gpu_ledger
    before_reserve = clock.now
    ledger.reserve("a", "ai", {"cpu_cores": 1})
    sample(started_at=before_reserve)
    assert ledger.gpu_report()[0]["waiting_reason"] == "gpu_metrics_unavailable"
    before_running = clock.now
    ledger.mark_running("a")
    sample(started_at=before_running)
    assert ledger.gpu_observations["GPU-a"].sampled_at == 0
    sample()
    stamp = clock.now
    sample(started_at=stamp)
    sample(started_at=stamp)
    assert ledger.gpu_observations["GPU-a"].stable_samples == 0
    sample()
    sample()
    assert ledger.gpu_report()[0]["admission_open"]
    before_cleanup = clock.now
    ledger.release("a")
    sample(started_at=before_cleanup)
    assert not ledger.gpu_report()[0]["admission_open"]
    sample()
    assert ledger.gpu_report()[0]["admission_open"]


@pytest.mark.parametrize("invalid", [[], [{"uuid": "GPU-a", "total_bytes": 16 * GIB, "free_bytes": -1}],
    [{"uuid": "GPU-a", "total_bytes": 16 * GIB, "free_bytes": "N/A"}],
    [{"uuid": "GPU-a", "total_bytes": 16 * GIB, "free_bytes": 17 * GIB}],
    [{"uuid": "GPU-a", "total_bytes": True, "free_bytes": 0}]])
def test_missing_or_invalid_metrics_reset_observation_and_leave_cpu_available(gpu_ledger, invalid):
    ledger, sample, _ = gpu_ledger
    ledger.reserve("a", "ai", {"cpu_cores": 1})
    ledger.mark_running("a")
    for _ in range(3):
        sample()
    sample(invalid=invalid)
    assert ledger.reserve("b", "ai", {"cpu_cores": 1})[0] is None
    assert ledger.reserve("cpu", "cae", {"cpu_cores": 1, "gpu_count": 0})[0]
    sample()
    sample()
    assert ledger.reserve("b", "ai", {"cpu_cores": 1})[0] is None
    sample()
    assert ledger.reserve("b", "ai", {"cpu_cores": 1})[0]


def test_failed_and_stale_gpu_queries_do_not_block_cpu(gpu_ledger):
    ledger, sample, clock = gpu_ledger
    ledger.reserve("a", "ai", {"cpu_cores": 1})
    ledger.mark_running("a")
    for _ in range(3):
        sample()
    ledger.sample({}, launcher_rss=0, available_ram=48 * GIB, gpus=None)
    assert not ledger.gpu_report()[0]["admission_open"]
    assert ledger.reserve("cpu", "cae", {"cpu_cores": 1, "gpu_count": 0})[0]
    sample()
    sample()
    assert not ledger.gpu_report()[0]["admission_open"]
    sample()
    clock.now += 4
    # Fresh RAM cannot make an old GPU query fresh.
    sample(started_at=clock.now - 4)
    assert not ledger.gpu_report()[0]["admission_open"]
    assert ledger.reserve("cpu2", "cae", {"cpu_cores": 1, "gpu_count": 0})[0]


def test_multi_gpu_atomic_admission_and_other_device_independence(gpu_ledger):
    ledger, sample, _ = gpu_ledger
    devices = ("GPU-a", "GPU-b")
    sample(devices=devices)
    assert ledger.reserve("a", "ai", {"cpu_cores": 1})[0]["gpu_devices"] == ["GPU-a"]
    assert ledger.reserve("multi", "ai", {"cpu_cores": 1, "gpu_count": 2})[0] is None
    assert "multi" not in ledger.reservations
    assert ledger.reserve("b", "ai", {"cpu_cores": 1})[0]["gpu_devices"] == ["GPU-b"]
    ledger.mark_running("a")
    ledger.mark_running("b")
    for _ in range(3):
        sample(devices=devices)
    assert ledger.reserve("multi", "ai", {"cpu_cores": 1, "gpu_count": 2})[0]["gpu_devices"] == list(devices)
    assert all(gpu["job_count"] == 2 for gpu in ledger.gpu_report())


def test_budget_is_reserved_for_the_whole_lifetime(gpu_ledger):
    ledger, sample, _ = gpu_ledger
    assert ledger.reserve("too-large", "ai", {"vram_budget_gb": 17})[0] is None
    assert ledger.reserve("a", "ai", {"cpu_cores": 1, "vram_budget_gb": 10})[0]
    ledger.mark_running("a")
    for _ in range(3):
        sample()
    assert ledger.reserve("b", "ai", {"cpu_cores": 1, "vram_budget_gb": 7})[0] is None
    assert ledger.reserve("b", "ai", {"cpu_cores": 1, "vram_budget_gb": 6})[0]
    assert ledger.gpu_report()[0]["vram_reserved_bytes"] == 16 * GIB


def test_24_gib_allows_12_plus_6_plus_6_but_not_7(gpu_ledger):
    ledger, _, clock = gpu_ledger
    def sample():
        clock.now += 1
        ledger.sample({}, launcher_rss=0, available_ram=48 * GIB, gpu_process_metrics_complete=True,
            gpus=[{"uuid": "GPU-a", "total_bytes": 24 * GIB, "free_bytes": 20 * GIB}])
    sample()
    for instance, budget in (("a", 12), ("b", 6)):
        assert ledger.reserve(instance, "ai", {"cpu_cores": 1, "vram_budget_gb": budget})[0]
        ledger.mark_running(instance)
        for _ in range(3):
            sample()
    assert ledger.reserve("c", "ai", {"cpu_cores": 1, "vram_budget_gb": 7})[0] is None
    assert ledger.reserve("c", "ai", {"cpu_cores": 1, "vram_budget_gb": 6})[0]
    assert ledger.gpu_report()[0]["job_count"] == 3
    assert ledger.gpu_report()[0]["vram_reserved_bytes"] == 24 * GIB
