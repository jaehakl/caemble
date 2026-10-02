"""Metric scope, process lifetimes and advisory failure behavior."""
from types import SimpleNamespace
import threading
import time

import psutil
import pytest

from sdk.process_metrics import ProcessMetrics


class Process:
    def __init__(self, pid, created, rss, cpu):
        self.pid, self.created, self.rss, self.cpu = pid, created, rss, cpu

    def create_time(self):
        return self.created

    def memory_info(self):
        return SimpleNamespace(rss=self.rss)

    def cpu_times(self):
        return SimpleNamespace(user=self.cpu, system=0.)


def test_tree_peak_and_cpu_interval_include_new_children(monkeypatch):
    root = Process(1, 1., 100, 9.)
    processes = [root]
    metrics = ProcessMetrics(rss_interval_seconds=60)
    monkeypatch.setattr(metrics, "_processes", lambda: processes)
    with metrics:
        root.cpu = 10.
        processes.append(Process(2, 2., 200, 3.))
        metrics._sample_rss()
        assert metrics.snapshot()["peakRssBytes"] == 300
        processes.pop()
    assert metrics.result["sampledCpuSeconds"] == 4.
    assert metrics.result["peakRssBytes"] == 300
    assert metrics.result["gpuStatus"] == "not-requested"
    assert all(not thread.is_alive() for thread in metrics._threads)


def test_gpu_snapshot_rejects_pid_reuse_and_outside_processes(monkeypatch):
    processes = [Process(1, 1., 100, 0.), Process(2, 2., 200, 0.)]
    metrics = ProcessMetrics(["GPU-a"], rss_interval_seconds=60, gpu_interval_seconds=60)
    monkeypatch.setattr(metrics, "_processes", lambda: processes)
    def sample(devices):
        processes[1] = Process(2, 3., 200, 0.)
        return {"GPU-a": {1: 10, 2: 200, 999: 500}}
    monkeypatch.setattr(metrics._monitor, "sample", sample)
    with metrics:
        metrics._sample_gpu()
    assert metrics.result["peakVramBytes"] == {"GPU-a": 10}
    assert metrics.result["gpuSamples"] == 1


def test_unavailable_measurements_remain_null_and_do_not_hide_work_failure(monkeypatch):
    metrics = ProcessMetrics(["GPU-a"], rss_interval_seconds=60, gpu_interval_seconds=60)
    def unavailable():
        raise psutil.AccessDenied(1)
    monkeypatch.setattr(metrics, "_processes", unavailable)
    with pytest.raises(RuntimeError, match="work failed"):
        with metrics:
            metrics._sample_gpu()
            raise RuntimeError("work failed")
    assert metrics.result["peakRssBytes"] is None
    assert metrics.result["peakVramBytes"] == {"GPU-a": None}
    assert metrics.result["rssStatus"] == metrics.result["gpuStatus"] == "unavailable"
    assert metrics.result["warnings"]


def test_short_gpu_request_does_not_run_external_probe(monkeypatch):
    metrics = ProcessMetrics(["GPU-a"], rss_interval_seconds=60, gpu_interval_seconds=60)
    monkeypatch.setattr(metrics._monitor, "sample", lambda devices: pytest.fail("unexpected GPU query"))
    with metrics:
        assert metrics.snapshot()["elapsedSeconds"] >= 0
    assert metrics.result["gpuStatus"] == "unavailable"
    assert metrics.result["peakVramBytes"] == {"GPU-a": None}


def test_root_pid_reuse_ends_observation(monkeypatch):
    process = Process(1, 1., 100, 0.)
    process.children = lambda recursive: []
    monkeypatch.setattr("sdk.process_metrics.psutil.Process", lambda pid: process)
    with ProcessMetrics(root_pid=1, rss_interval_seconds=60) as metrics:
        process.created = 2.
        process.rss = 10000
        metrics._sample_rss()
    assert metrics.result["peakRssBytes"] == 100


def test_slow_gpu_probe_cannot_block_cleanup_or_change_finished_report(monkeypatch):
    entered, finish = threading.Event(), threading.Event()
    metrics = ProcessMetrics(["GPU-a"], gpu_interval_seconds=.001)
    def sample(devices):
        entered.set()
        assert finish.wait(5)
        return {"GPU-a": {metrics.root_pid: 1000}}
    monkeypatch.setattr(metrics._monitor, "sample", sample)
    metrics.__enter__()
    try:
        assert entered.wait(2)
        started = time.perf_counter()
        metrics.close()
        assert time.perf_counter() - started < .5
        report = metrics.result
        assert report["peakVramBytes"] == {"GPU-a": None}
        assert "Resource measurement is finishing after the operation" in report["warnings"]
    finally:
        finish.set()
        for thread in metrics._threads:
            thread.join(2)
    assert metrics.result == report


def test_background_thread_limit_does_not_fail_the_operation(monkeypatch):
    def unavailable(thread):
        raise RuntimeError("can't start new thread")
    monkeypatch.setattr(threading.Thread, "start", unavailable)
    with ProcessMetrics() as metrics:
        assert metrics.snapshot()["rssStatus"] == "measured"
    assert metrics.result["rssSamples"] == 2
    assert "Background resource measurement could not start" in metrics.result["warnings"]
