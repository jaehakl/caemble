from __future__ import annotations

import asyncio
import ctypes
import gc
import importlib.util
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.logging import log
from app.gpu_residency import acquire_gpu_model_multi, get_cuda_device_count
from app.llm.generation import (
    GenerationOutputParser,
    ThinkingEffort,
    apply_thinking_effort,
    resolve_thinking,
    thinking_override,
)
from app.model_catalog import resolve_llm_model

LLM_SPLIT_MODE_NONE = 0
LLM_SPLIT_MODE_LAYER = 1
LLM_SPLIT_MODE_ROW = 2
LLM_SPLIT_MODE_TENSOR = 3
LLM_SPLIT_MODE_NAMES = {
    "none": LLM_SPLIT_MODE_NONE,
    "layer": LLM_SPLIT_MODE_LAYER,
    "row": LLM_SPLIT_MODE_ROW,
    "tensor": LLM_SPLIT_MODE_TENSOR,
}

_prompt_llm_lock = asyncio.Lock()
PromptLlmModelKey = tuple[
    str,
    int,
    int,
    int | None,
    int | None,
    int | None,
    tuple[float, ...] | None,
    tuple[int, ...],
    bool,
    bool,
    int,
    int,
    bool,
    bool,
]
_prompt_llm_model_key: PromptLlmModelKey | None = None
_prompt_llm: Any | None = None
_llm_dll_directory_handles: list[Any] = []
_llm_loaded_dlls: list[Any] = []


@dataclass(frozen=True)
class PromptLlmConfig:
    name: str
    model_path: str
    context_size: int
    n_gpu_layers: int
    n_threads: int | None
    main_gpu: int | None
    split_mode: int | None
    tensor_split: tuple[float, ...] | None
    lease_device_ids: tuple[int, ...]
    flash_attn: bool
    swa_full: bool
    n_batch: int
    n_ubatch: int
    offload_kqv: bool
    enable_thinking: bool
    model_key: PromptLlmModelKey
    max_tokens: int
    temperature: float
    top_p: float


async def generate_prompt_with_llm(
    messages: list[dict[str, str]],
    model_name: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    context_size: int | None = None,
    top_p: float | None = None,
    enable_thinking: bool | None = None,
    thinking_effort: ThinkingEffort = "default",
    response_format_json: bool = True,
) -> str:
    config = build_prompt_llm_config(
        model_name=model_name,
        max_tokens=max_tokens,
        temperature=temperature,
        context_size=context_size,
        top_p=top_p,
    )
    effective_enable_thinking = resolve_thinking(config.enable_thinking, enable_thinking)
    generation_messages = apply_thinking_effort(messages, effective_enable_thinking, thinking_effort)
    async with acquire_gpu_model_multi("llm", config.lease_device_ids, config.model_key, release_llm_runtime):
        async with _prompt_llm_lock:
            return await asyncio.to_thread(
                _generate_prompt_with_llm_locked,
                config,
                generation_messages,
                enable_thinking,
                response_format_json,
            )


async def ask_llm(
    system_message: str,
    question: str,
    model_name: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    context_size: int | None = None,
    top_p: float | None = None,
    enable_thinking: bool | None = None,
    thinking_effort: ThinkingEffort = "default",
    response_format_json: bool = False,
) -> str:
    trimmed_system_message = system_message.strip()
    trimmed_question = question.strip()
    if not trimmed_system_message:
        raise ValueError("system_message is required")
    if not trimmed_question:
        raise ValueError("question is required")
    answer = await generate_prompt_with_llm(
        [
            {"role": "system", "content": trimmed_system_message},
            {"role": "user", "content": trimmed_question},
        ],
        model_name=model_name,
        max_tokens=max_tokens,
        temperature=temperature,
        context_size=context_size,
        top_p=top_p,
        enable_thinking=enable_thinking,
        thinking_effort=thinking_effort,
        response_format_json=response_format_json,
    )
    if not answer.strip():
        raise RuntimeError("LLM returned empty answer")
    return answer


def build_prompt_llm_config(
    model_name: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    context_size: int | None = None,
    top_p: float | None = None,
) -> PromptLlmConfig:
    model, model_path_value = resolve_llm_model(model_name)
    resolved_max_tokens = model.max_tokens if max_tokens is None else max_tokens
    resolved_temperature = model.temperature if temperature is None else temperature
    resolved_context_size = model.context_size if context_size is None else context_size
    resolved_top_p = model.top_p if top_p is None else top_p
    use_gpu = model.use_max_gpu
    cuda_device_count = get_cuda_device_count() if use_gpu else 0
    main_gpu = _resolve_llm_main_gpu(use_gpu, cuda_device_count, model.main_gpu)
    n_gpu_layers = model.n_gpu_layers if model.n_gpu_layers is not None else (-1 if use_gpu else 0)
    split_mode = _parse_llm_split_mode(model.split_mode) if main_gpu is not None else None
    tensor_split = tuple(model.tensor_split) or None if main_gpu is not None else None
    if split_mode == LLM_SPLIT_MODE_NONE:
        tensor_split = None
    lease_device_ids = _resolve_llm_lease_device_ids(
        main_gpu=main_gpu,
        split_mode=split_mode,
        tensor_split=tensor_split,
        cuda_device_count=cuda_device_count,
    )
    context_size = resolved_context_size
    flash_attn = model.flash_attn
    swa_full = model.swa_full
    n_batch = model.n_batch
    n_ubatch = model.n_ubatch
    offload_kqv = model.offload_kqv
    enable_thinking = model.enable_thinking
    model_key = (
        model_path_value,
        context_size,
        n_gpu_layers,
        model.n_threads,
        main_gpu,
        split_mode,
        tensor_split,
        lease_device_ids,
        flash_attn,
        swa_full,
        n_batch,
        n_ubatch,
        offload_kqv,
        enable_thinking,
    )
    return PromptLlmConfig(
        name=model.name,
        model_path=model_path_value,
        context_size=context_size,
        n_gpu_layers=n_gpu_layers,
        n_threads=model.n_threads,
        main_gpu=main_gpu,
        split_mode=split_mode,
        tensor_split=tensor_split,
        lease_device_ids=lease_device_ids,
        flash_attn=flash_attn,
        swa_full=swa_full,
        n_batch=n_batch,
        n_ubatch=n_ubatch,
        offload_kqv=offload_kqv,
        enable_thinking=enable_thinking,
        model_key=model_key,
        max_tokens=resolved_max_tokens,
        temperature=resolved_temperature,
        top_p=resolved_top_p,
    )


def _resolve_llm_main_gpu(use_gpu: bool, cuda_device_count: int, main_gpu: int) -> int | None:
    if not use_gpu or cuda_device_count <= 0:
        return None
    return main_gpu


def _parse_llm_split_mode(value: str) -> int:
    normalized = value.strip().lower()
    split_mode = LLM_SPLIT_MODE_NAMES.get(normalized)
    if split_mode is None:
        raise ValueError("split_mode must be one of: none, layer, row, tensor")
    return split_mode


def _resolve_llm_lease_device_ids(
    main_gpu: int | None,
    split_mode: int | None,
    tensor_split: tuple[float, ...] | None,
    cuda_device_count: int,
) -> tuple[int, ...]:
    if main_gpu is None or cuda_device_count <= 0:
        return ()
    if split_mode == LLM_SPLIT_MODE_NONE:
        return (main_gpu,)
    if tensor_split is not None:
        return tuple(range(len(tensor_split)))
    return tuple(range(cuda_device_count))


def reset_llm_runtime_for_tests() -> None:
    release_llm_runtime()


def warmup_llm_import() -> None:
    _load_llama_cls("startup")


def release_llm_runtime(device_id: int | None = None) -> None:
    global _prompt_llm_model_key, _prompt_llm

    llm = _prompt_llm
    _prompt_llm = None
    _prompt_llm_model_key = None
    if llm is not None:
        close = getattr(llm, "close", None)
        if callable(close):
            close()
        del llm
    gc.collect()


def _generate_prompt_with_llm_locked(
    config: PromptLlmConfig,
    messages: list[dict[str, str]],
    enable_thinking: bool | None,
    response_format_json: bool,
) -> str:
    llm = _get_prompt_llm_locked(config)
    effective_enable_thinking = resolve_thinking(config.enable_thinking, enable_thinking)
    log(
        "LLM completion start "
        f"max_tokens={config.max_tokens} "
        f"temperature={config.temperature} "
        f"enable_thinking={effective_enable_thinking}"
    )
    completion_kwargs: dict[str, Any] = {
        "messages": messages,
        "max_tokens": config.max_tokens,
        "temperature": config.temperature,
        "top_p": config.top_p,
    }
    if response_format_json and not effective_enable_thinking:
        completion_kwargs["response_format"] = {"type": "json_object"}
    with thinking_override(llm, enable_thinking):
        response = llm.create_chat_completion(**completion_kwargs)
    log("LLM completion returned")
    if not isinstance(response, dict):
        return ""

    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""

    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        return ""

    message = first_choice.get("message")
    if not isinstance(message, dict):
        return ""

    content = message.get("content")
    if not isinstance(content, str):
        return ""
    parser = GenerationOutputParser(
        expect_reasoning=effective_enable_thinking,
        response_format="json" if response_format_json else "text",
    )
    parser.feed(content)
    return parser.finish(config.name).answer


def _create_llm_chat_handler(enable_thinking: bool) -> Any:
    def chat_handler(**kwargs: Any) -> Any:
        llama = kwargs.get("llama")
        base_handler = _resolve_llm_chat_handler(llama)
        request_enable_thinking = getattr(llama, "_caemble_enable_thinking_override", None)
        if isinstance(request_enable_thinking, bool):
            kwargs["enable_thinking"] = request_enable_thinking
        else:
            kwargs.setdefault("enable_thinking", enable_thinking)
        return base_handler(**kwargs)

    return chat_handler


def _resolve_llm_chat_handler(llama: Any) -> Any:
    metadata_handlers = getattr(llama, "_chat_handlers", {})
    if isinstance(metadata_handlers, dict):
        default_handler = metadata_handlers.get("chat_template.default")
        if default_handler is not None:
            return default_handler
        chat_format = getattr(llama, "chat_format", None)
        if chat_format:
            format_handler = metadata_handlers.get(chat_format)
            if format_handler is not None:
                return format_handler

    chat_format = getattr(llama, "chat_format", None) or "llama-2"
    from llama_cpp import llama_chat_format

    return llama_chat_format.get_chat_completion_handler(chat_format)


def _get_prompt_llm_locked(config: PromptLlmConfig) -> Any:
    global _prompt_llm_model_key, _prompt_llm

    model_key = config.model_key
    if _prompt_llm is not None and _prompt_llm_model_key != model_key:
        release_llm_runtime()

    if _prompt_llm is None:
        model_ref = config.model_path
        try:
            Llama = _load_llama_cls(model_ref)
        except (ModuleNotFoundError, OSError, RuntimeError) as exc:
            raise RuntimeError(
                "llama-cpp-python is not available or failed to load its native libraries. "
                "Install a wheel that matches this machine, then restart the worker."
            ) from exc

        llama_kwargs: dict[str, Any] = {
            "n_ctx": config.context_size,
            "n_gpu_layers": config.n_gpu_layers,
            "flash_attn": config.flash_attn,
            "swa_full": config.swa_full,
            "n_batch": config.n_batch,
            "n_ubatch": config.n_ubatch,
            "offload_kqv": config.offload_kqv,
            "chat_handler": _create_llm_chat_handler(config.enable_thinking),
            "verbose": False,
        }
        if config.n_threads is not None:
            llama_kwargs["n_threads"] = config.n_threads
        if config.main_gpu is not None:
            llama_kwargs["main_gpu"] = config.main_gpu
        if config.split_mode is not None:
            llama_kwargs["split_mode"] = config.split_mode
        if config.tensor_split is not None and config.split_mode != LLM_SPLIT_MODE_NONE:
            llama_kwargs["tensor_split"] = list(config.tensor_split)

        log(
            "loading LLM model "
            f"model={model_ref} "
            f"main_gpu={config.main_gpu} "
            f"n_gpu_layers={config.n_gpu_layers} "
            f"n_threads={config.n_threads} "
            f"context_size={config.context_size} "
            f"split_mode={config.split_mode} "
            f"tensor_split={config.tensor_split} "
            f"lease_device_ids={config.lease_device_ids} "
            f"flash_attn={config.flash_attn} "
            f"swa_full={config.swa_full} "
            f"n_batch={config.n_batch} "
            f"n_ubatch={config.n_ubatch} "
            f"offload_kqv={config.offload_kqv} "
            f"enable_thinking={config.enable_thinking}"
        )
        try:
            _prompt_llm = Llama(
                model_path=config.model_path,
                **llama_kwargs,
            )
        except ValueError as exc:
            if "Failed to create llama_context" not in str(exc):
                raise
            raise RuntimeError(
                "Failed to create llama_context with LLM config: "
                f"context_size={config.context_size}, "
                f"n_gpu_layers={config.n_gpu_layers}, "
                f"n_threads={config.n_threads}, "
                f"split_mode={config.split_mode}, "
                f"tensor_split={config.tensor_split}, "
                f"flash_attn={config.flash_attn}, "
                f"swa_full={config.swa_full}, "
                f"n_batch={config.n_batch}, "
                f"n_ubatch={config.n_ubatch}, "
                f"offload_kqv={config.offload_kqv}. "
                "Hint: lower context_size, enable flash_attn, disable swa_full, "
                "or lower n_batch/n_ubatch for this model in models.toml."
            ) from exc
        _prompt_llm_model_key = model_key
        log(f"LLM model loaded model={model_ref}")
    return _prompt_llm


def _load_llama_cls(model_ref: str) -> Any:
    log(f"preparing LLM native libraries model={model_ref}")
    _add_llm_dll_directories()
    log(f"importing llama_cpp model={model_ref}")
    from llama_cpp import Llama
    log(f"llama_cpp imported model={model_ref}")
    return Llama


def _add_llm_dll_directories() -> None:
    if _llm_loaded_dlls:
        return

    llama_lib_paths: list[Path] = []
    llama_cpp_spec = importlib.util.find_spec("llama_cpp")
    if llama_cpp_spec is not None and llama_cpp_spec.submodule_search_locations is not None:
        for location in llama_cpp_spec.submodule_search_locations:
            dll_path = Path(location) / "lib"
            if dll_path.exists():
                llama_lib_paths.append(dll_path)
                if hasattr(os, "add_dll_directory"):
                    _llm_dll_directory_handles.append(os.add_dll_directory(str(dll_path)))

    nvidia_lib_paths: list[Path] = []
    nvidia_spec = importlib.util.find_spec("nvidia")
    if nvidia_spec is not None and nvidia_spec.submodule_search_locations is not None:
        for location in nvidia_spec.submodule_search_locations:
            for dll_path in (
                Path(location) / "cu13" / "bin" / "x86_64",
                Path(location) / "cu13" / "lib",
            ):
                if dll_path.exists():
                    nvidia_lib_paths.append(dll_path)
                    if hasattr(os, "add_dll_directory"):
                        _llm_dll_directory_handles.append(os.add_dll_directory(str(dll_path)))

    load_kwargs = {"mode": ctypes.RTLD_GLOBAL} if hasattr(ctypes, "RTLD_GLOBAL") else {}
    for dll_name in ("libcudart.so.13", "cudart64_13.dll", "libcublasLt.so.13", "libcublas.so.13", "cublas64_13.dll"):
        for dll_path in nvidia_lib_paths:
            full_path = dll_path / dll_name
            if full_path.exists():
                _llm_loaded_dlls.append(ctypes.CDLL(str(full_path), **load_kwargs))
                break

    for dll_name in (
        "ggml-base.dll",
        "ggml-cpu.dll",
        "ggml-cuda.dll",
        "ggml.dll",
        "llama.dll",
        "libggml-base.so",
        "libggml-cpu.so",
        "libggml-cuda.so",
        "libggml.so",
        "libllama.so",
    ):
        for dll_path in llama_lib_paths:
            full_path = dll_path / dll_name
            if full_path.exists():
                _llm_loaded_dlls.append(ctypes.CDLL(str(full_path), **load_kwargs))
                break
