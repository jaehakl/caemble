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


def test_predictor_identity_and_origin_come_from_authenticated_launcher(monkeypatch, tmp_path):
    monkeypatch.setenv("CAEMBLE_PREDICTOR_OWNER_ID", "untrusted-parent")
    monkeypatch.setenv("CAEMBLE_PREDICTOR_API_URL", "https://untrusted.example")
    settings = LauncherSettings(_env_file=None, api_url="http://localhost:8000/", access_token="secret",
                                predictor_storage_root=tmp_path)
    env = subprocess_env(settings, owner_id="authenticated-user")
    assert env["CAEMBLE_PREDICTOR_OWNER_ID"] == "authenticated-user"
    assert env["CAEMBLE_PREDICTOR_API_URL"] == "http://localhost:8000"
    assert env["CAEMBLE_PREDICTOR_STORAGE_ROOT"] == str(tmp_path.resolve())
    assert "CAEMBLE_ACCESS_TOKEN" not in env
    assert "CAEMBLE_PREDICTOR_OWNER_ID" not in subprocess_env(settings)
