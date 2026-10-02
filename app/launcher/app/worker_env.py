from __future__ import annotations

import json
import os
from typing import Any

from sdk.slave.execution import NATIVE_THREAD_ENV
from sdk.protocol.execution import EXECUTION_PROTOCOL_VERSION

from app.settings import LauncherSettings


def json_line(message: dict[str, Any]) -> bytes:
    return (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")


def subprocess_env(settings: LauncherSettings, execution: dict[str, Any] | None = None,
                   *, owner_id: str | None = None) -> dict[str, str]:
    inherited_names = (
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "CUDA_VISIBLE_DEVICES",
        "CUDA_PATH",
        "CUDA_HOME",
        "NVIDIA_VISIBLE_DEVICES",
        "HF_HOME",
        "HUGGINGFACE_HUB_CACHE",
        "TRANSFORMERS_CACHE",
        "TORCH_HOME",
        "XDG_CACHE_HOME",
        "SSL_CERT_FILE",
        "REQUESTS_CA_BUNDLE",
    )
    env = {name: os.environ[name] for name in inherited_names if name in os.environ}
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    if owner_id is not None:
        env["CAEMBLE_PREDICTOR_OWNER_ID"] = owner_id
        env["CAEMBLE_PREDICTOR_API_URL"] = settings.api_url.rstrip("/")
    if settings.predictor_storage_root is not None:
        env["CAEMBLE_PREDICTOR_STORAGE_ROOT"] = str(settings.predictor_storage_root.expanduser().resolve())
    if settings.cae_cpu_budget is not None:
        env["CAEMBLE_CAE_CPU_BUDGET"] = str(settings.cae_cpu_budget)
    env["GPSTATION_V1_RTC_ICE_SERVERS_JSON"] = settings.rtc_ice_servers_json
    if settings.rtc_ice_gather_timeout_seconds:
        env["GPSTATION_V1_RTC_ICE_GATHER_TIMEOUT_SECONDS"] = settings.rtc_ice_gather_timeout_seconds
    if settings.rtc_memory_cache_enabled:
        env["GPSTATION_V1_RTC_MEMORY_CACHE_ENABLED"] = settings.rtc_memory_cache_enabled
    if execution is not None:
        env["CAEMBLE_EXECUTION_JSON"] = json.dumps({**execution, "execution_protocol": EXECUTION_PROTOCOL_VERSION})
        env["CAEMBLE_CAE_CPU_BUDGET"] = str(execution["allocation"]["cpu_cores"])
        env["CUDA_VISIBLE_DEVICES"] = ",".join(execution["allocation"]["gpu_devices"])
        for name in NATIVE_THREAD_ENV:
            env[name] = str(execution["allocation"]["cpu_cores"])
        env["TOKENIZERS_PARALLELISM"] = "false"
    return env
