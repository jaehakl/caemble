from __future__ import annotations

import asyncio
import gc
import random
import threading
from typing import Any

from app.logging import log
from app.gpu_residency import acquire_gpu_model, get_image_cuda_device_id


_image_locks: dict[int, asyncio.Lock] = {}
_image_ckpt_paths: dict[int, str] = {}
_image_pipe_modes: dict[int, str] = {}
_image_controlnet_model_ids_by_device: dict[int, tuple[str, ...] | None] = {}
_image_pipes: dict[int, Any] = {}
_diffusers_import_lock = threading.Lock()


async def generate_images_batch(
    ckpt_path: str,
    image_mode: str,
    positive_prompt_list: list[str],
    negative_prompt_list: list[str],
    init_image_list: list[Any],
    mask_image_list: list[Any],
    controlnet_image_list: list[list[Any]],
    seed_list: list[int | None],
    step: int,
    cfg: float,
    height: int,
    width: int,
    strength: float,
    max_chunk_size: int,
    seed_min: int,
    seed_max: int,
    sampler: str,
    scheduler: str,
    clip_skip: int | None,
    controlnet_model_ids: list[str],
    controlnet_conditioning_scales: list[float],
    control_guidance_starts: list[float],
    control_guidance_ends: list[float],
) -> tuple[list[Any], list[int]]:
    normalized_image_mode = image_mode.strip().lower()
    device_id = get_image_cuda_device_id()
    controlnet_key = tuple(controlnet_model_ids) if normalized_image_mode.startswith("controlnet_") else None
    model_key = ckpt_path, normalized_image_mode, controlnet_key
    generation_args = (
        ckpt_path,
        normalized_image_mode,
        positive_prompt_list,
        negative_prompt_list,
        init_image_list,
        mask_image_list,
        controlnet_image_list,
        seed_list,
        step,
        cfg,
        height,
        width,
        strength,
        max_chunk_size,
        seed_min,
        seed_max,
        sampler,
        scheduler,
        clip_skip,
        controlnet_model_ids,
        controlnet_conditioning_scales,
        control_guidance_starts,
        control_guidance_ends,
        device_id,
    )
    lease = acquire_gpu_model(
        "sdxl",
        device_id,
        model_key,
        release_image_runtime,
        exclusive=False,
    )
    async with lease:
        async with _get_image_lock(device_id):
            torch = _load_image_torch()
            try:
                return await asyncio.to_thread(_generate_images_batch_locked, *generation_args)
            except torch.cuda.OutOfMemoryError as exc:
                if not await lease.evict_co_resident_models():
                    raise
                exc.__traceback__ = None
                log(f"SDXL CUDA OOM evicted co-resident vision models device=cuda:{device_id}; retrying")
                _clear_cuda_cache(torch, device_id)
                return await asyncio.to_thread(_generate_images_batch_locked, *generation_args)


def warmup_sdxl_imports() -> None:
    log("importing torch for SDXL")
    _load_image_torch()
    log("torch imported for SDXL")
    _load_diffusers_attrs(
        "StableDiffusionXLPipeline",
        "StableDiffusionXLImg2ImgPipeline",
        "StableDiffusionXLInpaintPipeline",
        "ControlNetModel",
        "StableDiffusionXLControlNetPipeline",
        "StableDiffusionXLControlNetImg2ImgPipeline",
        "StableDiffusionXLControlNetInpaintPipeline",
        "EulerDiscreteScheduler",
        "EulerAncestralDiscreteScheduler",
        "DPMSolverMultistepScheduler",
        "UniPCMultistepScheduler",
    )


def get_available_cuda_device_ids() -> list[int]:
    try:
        torch = _load_image_torch()
        if not torch.cuda.is_available():
            return []
        return list(range(torch.cuda.device_count()))
    except Exception:
        return []


def release_image_runtime(device_id: int) -> None:
    pipe = _image_pipes.pop(device_id, None)
    _image_ckpt_paths.pop(device_id, None)
    _image_pipe_modes.pop(device_id, None)
    _image_controlnet_model_ids_by_device.pop(device_id, None)
    if pipe is not None:
        del pipe

    try:
        torch = _load_image_torch()
    except Exception:
        gc.collect()
        return
    if torch.cuda.is_available() and device_id < torch.cuda.device_count():
        _clear_cuda_cache(torch, device_id)
    else:
        gc.collect()


def _generate_images_batch_locked(
    ckpt_path: str,
    image_mode: str,
    positive_prompt_list: list[str],
    negative_prompt_list: list[str],
    init_image_list: list[Any],
    mask_image_list: list[Any],
    controlnet_image_list: list[list[Any]],
    seed_list: list[int | None],
    step: int,
    cfg: float,
    height: int,
    width: int,
    strength: float,
    max_chunk_size: int,
    seed_min: int,
    seed_max: int,
    sampler: str,
    scheduler: str,
    clip_skip: int | None,
    controlnet_model_ids: list[str],
    controlnet_conditioning_scales: list[float],
    control_guidance_starts: list[float],
    control_guidance_ends: list[float],
    device_id: int,
) -> tuple[list[Any], list[int]]:
    normalized_image_mode = image_mode.strip().lower()
    torch = _load_image_torch()
    device = _cuda_device_name(device_id)
    pipe = _get_image_pipe_locked(ckpt_path, normalized_image_mode, controlnet_model_ids, torch, device_id)
    sampler_key = sampler.strip().lower()
    scheduler_key = scheduler.strip().lower()
    if sampler_key:
        if sampler_key == "euler":
            EulerDiscreteScheduler = _load_diffusers_attr("EulerDiscreteScheduler")

            pipe.scheduler = EulerDiscreteScheduler.from_config(
                pipe.scheduler.config,
                use_karras_sigmas=scheduler_key == "karras",
            )
        elif sampler_key == "euler_a":
            EulerAncestralDiscreteScheduler = _load_diffusers_attr("EulerAncestralDiscreteScheduler")

            pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(pipe.scheduler.config)
        elif sampler_key == "dpmpp_2m":
            DPMSolverMultistepScheduler = _load_diffusers_attr("DPMSolverMultistepScheduler")

            pipe.scheduler = DPMSolverMultistepScheduler.from_config(
                pipe.scheduler.config,
                algorithm_type="dpmsolver++",
                solver_order=2,
                use_karras_sigmas=scheduler_key == "karras",
            )
        elif sampler_key == "unipc":
            UniPCMultistepScheduler = _load_diffusers_attr("UniPCMultistepScheduler")

            pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config)

    images: list[Any] = []
    seeds: list[int] = []
    i = 0
    while i < len(positive_prompt_list):
        chunk_size = min(max_chunk_size, len(positive_prompt_list) - i)
        positive_prompt_chunk = positive_prompt_list[i:i + chunk_size]
        negative_prompt_chunk = negative_prompt_list[i:i + chunk_size]
        init_image_chunk = init_image_list[i:i + chunk_size]
        mask_image_chunk = mask_image_list[i:i + chunk_size]
        controlnet_image_chunk = controlnet_image_list[i:i + chunk_size]
        seed_chunk = [
            random.randint(seed_min, seed_max)
            if seed_list[i + j] is None
            else seed_list[i + j]
            for j in range(chunk_size)
        ]
        generators_chunk = [
            torch.Generator(device=device).manual_seed(seed_int)
            for seed_int in seed_chunk
        ]
        _clear_cuda_cache(torch, device_id)
        call_kwargs = {
            "prompt": positive_prompt_chunk,
            "negative_prompt": negative_prompt_chunk,
            "num_inference_steps": step,
            "guidance_scale": cfg,
            "generator": generators_chunk,
        }
        if normalized_image_mode == "t2i":
            call_kwargs["height"] = height
            call_kwargs["width"] = width
        elif normalized_image_mode == "i2i":
            call_kwargs["image"] = init_image_chunk
            call_kwargs["strength"] = strength
        elif normalized_image_mode == "inpaint":
            call_kwargs["image"] = init_image_chunk
            call_kwargs["mask_image"] = mask_image_chunk
            call_kwargs["height"] = height
            call_kwargs["width"] = width
            call_kwargs["strength"] = strength
        elif normalized_image_mode in {"controlnet_t2i", "controlnet_i2i", "controlnet_inpaint"}:
            if normalized_image_mode in {"controlnet_i2i", "controlnet_inpaint"}:
                call_kwargs["image"] = init_image_chunk
                call_kwargs["strength"] = strength
            if normalized_image_mode == "controlnet_inpaint":
                call_kwargs["mask_image"] = mask_image_chunk
            control_image_arg = (
                [controlnet_images[0] for controlnet_images in controlnet_image_chunk]
                if len(controlnet_model_ids) == 1
                else controlnet_image_chunk[0]
            )
            if normalized_image_mode == "controlnet_t2i":
                call_kwargs["image"] = control_image_arg
            else:
                call_kwargs["control_image"] = control_image_arg
            call_kwargs["height"] = height
            call_kwargs["width"] = width
            call_kwargs["controlnet_conditioning_scale"] = (
                controlnet_conditioning_scales[0]
                if len(controlnet_model_ids) == 1
                else controlnet_conditioning_scales
            )
            call_kwargs["control_guidance_start"] = (
                control_guidance_starts[0]
                if len(controlnet_model_ids) == 1
                else control_guidance_starts
            )
            call_kwargs["control_guidance_end"] = (
                control_guidance_ends[0]
                if len(controlnet_model_ids) == 1
                else control_guidance_ends
            )
        if clip_skip is not None:
            call_kwargs["clip_skip"] = clip_skip
        images.extend(pipe(**call_kwargs).images)
        seeds.extend(seed_chunk)
        i += chunk_size

    return images, seeds


def _get_image_pipe_locked(
    ckpt_path: str,
    image_mode: str,
    controlnet_model_ids: list[str],
    torch: Any,
    device_id: int,
) -> Any:
    is_controlnet_mode = image_mode.startswith("controlnet_")
    next_controlnet_model_ids = tuple(controlnet_model_ids) if is_controlnet_mode else None
    pipe = _image_pipes.get(device_id)
    if (
        pipe is not None
        and (
            _image_ckpt_paths.get(device_id) != ckpt_path
            or _image_pipe_modes.get(device_id) != image_mode
            or _image_controlnet_model_ids_by_device.get(device_id) != next_controlnet_model_ids
        )
    ):
        release_image_runtime(device_id)
        pipe = None

    if pipe is None:
        if image_mode == "t2i":
            pipeline_cls = _load_diffusers_attr("StableDiffusionXLPipeline")
        elif image_mode == "i2i":
            pipeline_cls = _load_diffusers_attr("StableDiffusionXLImg2ImgPipeline")
        elif image_mode == "inpaint":
            pipeline_cls = _load_diffusers_attr("StableDiffusionXLInpaintPipeline")
        elif is_controlnet_mode:
            (
                ControlNetModel,
                StableDiffusionXLControlNetImg2ImgPipeline,
                StableDiffusionXLControlNetInpaintPipeline,
                StableDiffusionXLControlNetPipeline,
            ) = _load_diffusers_attrs(
                "ControlNetModel",
                "StableDiffusionXLControlNetImg2ImgPipeline",
                "StableDiffusionXLControlNetInpaintPipeline",
                "StableDiffusionXLControlNetPipeline",
            )

            controlnets = [
                ControlNetModel.from_pretrained(
                    model_id,
                    torch_dtype=torch.float16,
                )
                for model_id in controlnet_model_ids
            ]
            controlnet = controlnets[0] if len(controlnets) == 1 else controlnets
            if image_mode == "controlnet_t2i":
                pipeline_cls = StableDiffusionXLControlNetPipeline
            elif image_mode == "controlnet_i2i":
                pipeline_cls = StableDiffusionXLControlNetImg2ImgPipeline
            elif image_mode == "controlnet_inpaint":
                pipeline_cls = StableDiffusionXLControlNetInpaintPipeline

        device = _cuda_device_name(device_id)
        log(f"loading Stable Diffusion {image_mode} checkpoint on {device}: {ckpt_path}")
        if is_controlnet_mode:
            log(f"loading ControlNet model(s) on {device}: {', '.join(controlnet_model_ids)}")
            pipe = pipeline_cls.from_single_file(
                ckpt_path,
                controlnet=controlnet,
                torch_dtype=torch.float16,
                use_safetensors=True,
            )
        else:
            pipe = pipeline_cls.from_single_file(
                ckpt_path,
                torch_dtype=torch.float16,
                use_safetensors=True,
            )
        pipe.to(device)

        pipe.enable_attention_slicing()
        pipe.enable_vae_slicing()
        _image_pipes[device_id] = pipe
        _image_ckpt_paths[device_id] = ckpt_path
        _image_pipe_modes[device_id] = image_mode
        _image_controlnet_model_ids_by_device[device_id] = next_controlnet_model_ids
        log(f"Stable Diffusion {image_mode} checkpoint loaded on {device}")
    return pipe


def _load_image_torch() -> Any:
    import torch

    return torch


def _load_diffusers_attr(name: str) -> Any:
    return _load_diffusers_attrs(name)[0]


def _load_diffusers_attrs(*names: str) -> tuple[Any, ...]:
    with _diffusers_import_lock:
        log(f"importing diffusers attrs={', '.join(names)}")
        import diffusers

        log(f"diffusers imported attrs={', '.join(names)}")
        return tuple(getattr(diffusers, name) for name in names)


def _get_image_lock(device_id: int) -> asyncio.Lock:
    lock = _image_locks.get(device_id)
    if lock is None:
        lock = asyncio.Lock()
        _image_locks[device_id] = lock
    return lock


def _cuda_device_name(device_id: int) -> str:
    return f"cuda:{device_id}"


def _clear_cuda_cache(torch: Any, device_id: int) -> None:
    with torch.cuda.device(_cuda_device_name(device_id)):
        torch.cuda.empty_cache()
    gc.collect()
