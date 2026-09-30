import json
import asyncio
import inspect
from types import SimpleNamespace

import pytest

from app.llm import runtime
from app.voicevox import runtime as voicevox


@pytest.fixture
def model(monkeypatch):
    value = SimpleNamespace(name="fake", max_tokens=8, temperature=.5, context_size=32, top_p=.9,
                            use_max_gpu=True, main_gpu=0, n_gpu_layers=-1, split_mode="tensor", tensor_split=[],
                            flash_attn=False, swa_full=False, n_batch=8, n_ubatch=4, offload_kqv=True,
                            enable_thinking=False, n_threads=32)
    monkeypatch.setattr(runtime, "resolve_llm_model", lambda _: (value, "fake.gguf"))
    return value


@pytest.fixture
def managed(monkeypatch):
    def allocate(devices=()):
        monkeypatch.setenv("CAEMBLE_EXECUTION_JSON", json.dumps({
            "identity": {"launcher_id": "launcher", "boot_id": "boot", "instance_id": "instance", "job_id": "job",
                         "attempt_id": "attempt", "attempt_count": 1, "reservation_id": "reservation"},
            "allocation": {"cpu_ids": [0, 1], "cpu_cores": 2, "startup_ram_bytes": 1024,
                           "ram_available_bytes": 2048, "gpu_devices": list(devices)},
        }))
        monkeypatch.setattr(runtime, "get_cuda_device_count", lambda: len(devices))
    allocate()
    return allocate


def test_cpu_allocation_disables_gpu_settings_and_caps_llama_prompt_threads(model, managed, monkeypatch):
    config = runtime.build_prompt_llm_config()
    assert (config.n_threads, config.n_gpu_layers, config.main_gpu, config.tensor_split, config.offload_kqv) == (2, 0, None, None, False)
    calls = []
    monkeypatch.setattr(runtime, "_prompt_llm", None)
    monkeypatch.setattr(runtime, "_prompt_llm_model_key", None)
    monkeypatch.setattr(runtime, "_load_llama_cls", lambda _: lambda **kwargs: calls.append(kwargs) or object())
    monkeypatch.setattr(runtime, "_create_llm_chat_handler", lambda _: None)
    runtime._get_prompt_llm_locked(config)
    assert calls[0]["n_threads"] == calls[0]["n_threads_batch"] == 2


def test_gpu_indices_are_local_to_allocated_devices(model, managed):
    managed(["GPU-physical-3"])
    assert runtime.build_prompt_llm_config().lease_device_ids == (0,)
    model.main_gpu = 1
    with pytest.raises(ValueError, match="main_gpu"):
        runtime.build_prompt_llm_config()
    model.main_gpu = 0
    model.tensor_split = [1, 1]
    with pytest.raises(ValueError, match="tensor_split"):
        runtime.build_prompt_llm_config()
    managed(["GPU-physical-3", "GPU-physical-5"])
    assert runtime.build_prompt_llm_config().lease_device_ids == (0, 1)


@pytest.mark.parametrize("requested", [0, 1, 20])
def test_voicevox_auto_and_explicit_threads_follow_allocation(managed, monkeypatch, requested):
    calls = []
    monkeypatch.setattr(voicevox, "_runtime", None)
    monkeypatch.setattr(voicevox.settings, "voicevox_cpu_num_threads", requested)
    monkeypatch.setattr(voicevox, "VoicevoxRuntime", lambda path, threads: calls.append(threads) or object())
    voicevox.get_voicevox_runtime()
    assert calls == [1 if requested == 1 else 2]


def test_sdxl_rejects_gpu_call_in_cpu_session_before_loading_models(managed):
    from app.sdxl.runtime import generate_images_batch

    with pytest.raises(ValueError, match="requires a GPU allocation"):
        asyncio.run(generate_images_batch(*[None] * len(inspect.signature(generate_images_batch).parameters)))
