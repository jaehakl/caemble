from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sdk import gpu_memory


def test_nvidia_process_snapshot_rejects_unknown_usage(monkeypatch):
    monkeypatch.setattr(gpu_memory, "os", SimpleNamespace(name="posix"))
    monkeypatch.setattr(gpu_memory.shutil, "which", lambda _: "nvidia-smi")
    query = Mock(return_value=SimpleNamespace(stdout="GPU-a, 123, 512\nGPU-b, 456, 128\n"))
    monkeypatch.setattr(gpu_memory.subprocess, "run", query)
    monitor = gpu_memory.GpuProcessMonitor()
    assert monitor.sample(["GPU-a"]) == {"GPU-a": {123: 512*1024**2}}
    query.return_value.stdout = "GPU-a, 123, N/A\n"
    with pytest.raises(ValueError):
        monitor.sample(["GPU-a"])
    query.return_value.stdout = ""
    assert monitor.sample(["GPU-a"]) == {"GPU-a": {}}


def test_wddm_query_failure_never_falls_back_to_empty_nvidia_data(monkeypatch):
    monkeypatch.setattr(gpu_memory, "os", SimpleNamespace(name="nt"))
    monitor = gpu_memory.GpuProcessMonitor()
    monitor.windows = SimpleNamespace(sample=Mock(side_effect=RuntimeError("PDH unavailable")), close=Mock())
    query = Mock(return_value=SimpleNamespace(stdout=""))
    monkeypatch.setattr(gpu_memory.subprocess, "run", query)
    with pytest.raises(RuntimeError, match="PDH unavailable"):
        monitor.sample(["GPU-a"])
    query.assert_not_called()


@pytest.mark.parametrize("driver,allowed", [("WDDM", False), ("TCC", True)])
def test_only_confirmed_tcc_devices_allow_nvidia_fallback(monkeypatch, driver, allowed):
    monkeypatch.setattr(gpu_memory, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(gpu_memory, "WindowsGpuCounters", Mock(side_effect=RuntimeError("no mapping")))
    monkeypatch.setattr(gpu_memory.shutil, "which", lambda _: "nvidia-smi")
    monkeypatch.setattr(gpu_memory.subprocess, "CREATE_NO_WINDOW", 0, raising=False)
    query = Mock(side_effect=[SimpleNamespace(stdout=f"GPU-a, {driver}\n"), SimpleNamespace(stdout="GPU-a, 123, 512\n")])
    monkeypatch.setattr(gpu_memory.subprocess, "run", query)
    monitor = gpu_memory.GpuProcessMonitor()
    if allowed:
        assert monitor.sample(["GPU-a"]) == {"GPU-a": {123: 512*1024**2}}
    else:
        with pytest.raises(RuntimeError, match="WDDM"):
            monitor.sample(["GPU-a"])
        assert query.call_count == 1
