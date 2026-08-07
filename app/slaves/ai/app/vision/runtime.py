from __future__ import annotations

import asyncio
import csv
import gc
from typing import Any

from PIL import Image

from app.gpu_residency import acquire_gpu_model, get_image_cuda_device_id
from app.logging import log
from app.vision.models import CLIP_MODEL_NAME, WD14_MODEL_REPO


_clip_lock = asyncio.Lock()
_wd14_lock = asyncio.Lock()
_clip_bundle: tuple[Any, Any, Any, Any, str] | None = None
_wd14_bundle: tuple[Any, Any, list[tuple[str, int]], Any, str] | None = None


async def encode_clip_image(image: Image.Image) -> list[float]:
    torch = _load_torch()
    device_id, device = _resolve_device(torch)
    lease = acquire_gpu_model(
        "clip",
        device_id,
        (CLIP_MODEL_NAME, device),
        release_clip_runtime,
        exclusive=False,
    )
    async with lease:
        async with _clip_lock:
            try:
                return await asyncio.to_thread(_encode_clip_image_locked, image, device)
            except torch.cuda.OutOfMemoryError as exc:
                if not await lease.evict_co_resident_models():
                    raise
                exc.__traceback__ = None
                log(f"CLIP CUDA OOM evicted co-resident vision models device={device}; retrying")
                _clear_cuda_cache(torch, device_id)
                return await asyncio.to_thread(_encode_clip_image_locked, image, device)


async def encode_clip_text(text: str) -> list[float]:
    torch = _load_torch()
    device_id, device = _resolve_device(torch)
    lease = acquire_gpu_model(
        "clip",
        device_id,
        (CLIP_MODEL_NAME, device),
        release_clip_runtime,
        exclusive=False,
    )
    async with lease:
        async with _clip_lock:
            try:
                return await asyncio.to_thread(_encode_clip_text_locked, text, device)
            except torch.cuda.OutOfMemoryError as exc:
                if not await lease.evict_co_resident_models():
                    raise
                exc.__traceback__ = None
                log(f"CLIP CUDA OOM evicted co-resident vision models device={device}; retrying")
                _clear_cuda_cache(torch, device_id)
                return await asyncio.to_thread(_encode_clip_text_locked, text, device)


async def extract_wd14_tags(image: Image.Image) -> tuple[str, list[str]]:
    torch = _load_torch()
    device_id, device = _resolve_device(torch)
    lease = acquire_gpu_model(
        "wd14",
        device_id,
        (WD14_MODEL_REPO, device),
        release_wd14_runtime,
        exclusive=False,
    )
    async with lease:
        async with _wd14_lock:
            try:
                return await asyncio.to_thread(_extract_wd14_tags_locked, image, device)
            except torch.cuda.OutOfMemoryError as exc:
                if not await lease.evict_co_resident_models():
                    raise
                exc.__traceback__ = None
                log(f"WD14 CUDA OOM evicted co-resident vision models device={device}; retrying")
                _clear_cuda_cache(torch, device_id)
                return await asyncio.to_thread(_extract_wd14_tags_locked, image, device)


def warmup_vision_imports() -> None:
    log("importing CLIP and WD14 runtime libraries")
    import clip  # noqa: F401
    import timm  # noqa: F401

    log("CLIP and WD14 runtime libraries imported")


def release_clip_runtime(device_id: int) -> None:
    global _clip_bundle

    bundle = _clip_bundle
    _clip_bundle = None
    if bundle is not None:
        del bundle
    _clear_cuda_cache(_load_torch(), device_id)


def release_wd14_runtime(device_id: int) -> None:
    global _wd14_bundle

    bundle = _wd14_bundle
    _wd14_bundle = None
    if bundle is not None:
        del bundle
    _clear_cuda_cache(_load_torch(), device_id)


def reset_vision_runtime_for_tests() -> None:
    global _clip_bundle, _wd14_bundle

    _clip_bundle = None
    _wd14_bundle = None


def _encode_clip_image_locked(image: Image.Image, device: str) -> list[float]:
    model, preprocess, _clip, torch, _device = _get_clip_bundle_locked(device)
    image_tensor = preprocess(image).unsqueeze(0).to(device)
    with torch.inference_mode():
        embedding = model.encode_image(image_tensor).float()
        embedding /= embedding.norm(dim=-1, keepdim=True).clamp_min(1e-12)
    return [float(value) for value in embedding[0].cpu().tolist()]


def _encode_clip_text_locked(text: str, device: str) -> list[float]:
    model, _preprocess, clip, torch, _device = _get_clip_bundle_locked(device)
    tokens = clip.tokenize([text], truncate=True).to(device)
    with torch.inference_mode():
        embedding = model.encode_text(tokens).float()
        embedding /= embedding.norm(dim=-1, keepdim=True).clamp_min(1e-12)
    return [float(value) for value in embedding[0].cpu().tolist()]


def _extract_wd14_tags_locked(image: Image.Image, device: str) -> tuple[str, list[str]]:
    model, transform, labels, torch, _device = _get_wd14_bundle_locked(device)
    image_tensor = transform(image).unsqueeze(0).to(device)
    with torch.inference_mode():
        output = model(image_tensor)
        if isinstance(output, (tuple, list)):
            output = output[0]
        probabilities = torch.sigmoid(output)[0].float().cpu().tolist()

    selected = []
    for label, probability in zip(labels, probabilities, strict=True):
        name, category = label
        threshold = 0.35 if category == 0 else 0.85
        if category in {0, 4} and probability > threshold:
            selected.append((name, probability))
    selected.sort(key=lambda item: item[1], reverse=True)
    keywords = [name for name, _probability in selected]
    return ", ".join(keywords), keywords


def _get_clip_bundle_locked(device: str) -> tuple[Any, Any, Any, Any, str]:
    global _clip_bundle

    if _clip_bundle is not None and _clip_bundle[4] != device:
        _clip_bundle = None
    if _clip_bundle is None:
        import clip

        torch = _load_torch()
        log(f"loading CLIP model={CLIP_MODEL_NAME} device={device}")
        model, preprocess = clip.load("ViT-L/14", device=device, jit=False)
        model.eval()
        _clip_bundle = model, preprocess, clip, torch, device
        log(f"CLIP model loaded model={CLIP_MODEL_NAME} device={device}")
    return _clip_bundle


def _get_wd14_bundle_locked(
    device: str,
) -> tuple[Any, Any, list[tuple[str, int]], Any, str]:
    global _wd14_bundle

    if _wd14_bundle is not None and _wd14_bundle[4] != device:
        _wd14_bundle = None
    if _wd14_bundle is None:
        import timm
        from huggingface_hub import hf_hub_download
        from timm.data import create_transform, resolve_model_data_config

        torch = _load_torch()
        log(f"loading WD14 model={WD14_MODEL_REPO} device={device}")
        model = timm.create_model(f"hf_hub:{WD14_MODEL_REPO}", pretrained=True)
        model = model.eval().to(device)
        transform = create_transform(**resolve_model_data_config(model), is_training=False)
        csv_path = hf_hub_download(repo_id=WD14_MODEL_REPO, filename="selected_tags.csv")
        with open(csv_path, encoding="utf-8") as file:
            labels = [(row["name"], int(row["category"])) for row in csv.DictReader(file)]
        _wd14_bundle = model, transform, labels, torch, device
        log(f"WD14 model loaded model={WD14_MODEL_REPO} device={device}")
    return _wd14_bundle


def _load_torch() -> Any:
    import torch

    return torch


def _resolve_device(torch: Any) -> tuple[int | None, str]:
    if not torch.cuda.is_available():
        return None, "cpu"
    device_id = get_image_cuda_device_id()
    return device_id, f"cuda:{device_id}"


def _clear_cuda_cache(torch: Any, device_id: int | None) -> None:
    gc.collect()
    if device_id is not None and torch.cuda.is_available() and device_id < torch.cuda.device_count():
        with torch.cuda.device(device_id):
            torch.cuda.empty_cache()
