import os

from sdk.slave.execution import NATIVE_THREAD_ENV

from app.settings import LauncherSettings
from app.worker_env import subprocess_env


def test_child_thread_limits_exist_before_spawn_without_mutating_parent(monkeypatch):
    for name in NATIVE_THREAD_ENV:
        monkeypatch.setenv(name, "99")
    monkeypatch.setenv("TOKENIZERS_PARALLELISM", "true")
    monkeypatch.setenv("CAEMBLE_CAE_CPU_BUDGET", "12")
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "GPU-parent")
    settings = LauncherSettings(_env_file=None, api_url="http://localhost", access_token="fixture")
    first = subprocess_env(settings, {"identity": {}, "allocation": {"cpu_cores": 2, "gpu_devices": ["GPU-first"]}})
    second = subprocess_env(settings, {"identity": {}, "allocation": {"cpu_cores": 1, "gpu_devices": []}})
    assert all(first[name] == "2" and second[name] == "1" for name in NATIVE_THREAD_ENV)
    assert first["TOKENIZERS_PARALLELISM"] == second["TOKENIZERS_PARALLELISM"] == "false"
    assert first["CAEMBLE_CAE_CPU_BUDGET"] == "2" and second["CAEMBLE_CAE_CPU_BUDGET"] == "1"
    assert first["CUDA_VISIBLE_DEVICES"] == "GPU-first" and second["CUDA_VISIBLE_DEVICES"] == ""
    assert all(os.environ[name] == "99" for name in NATIVE_THREAD_ENV)
    assert os.environ["TOKENIZERS_PARALLELISM"] == "true"
    assert os.environ["CAEMBLE_CAE_CPU_BUDGET"] == "12"
    assert os.environ["CUDA_VISIBLE_DEVICES"] == "GPU-parent"
