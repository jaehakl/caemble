from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


ModelKey = tuple[Any, ...]
ReleaseLoadedModel = Callable[[int], None]


@dataclass(frozen=True)
class LoadedGpuModel:
    role: str
    model_key: ModelKey
    release_loaded_model: ReleaseLoadedModel
    device_ids: tuple[int, ...]
    exclusive: bool


_gpu_locks: dict[int, asyncio.Lock] = {}
_loaded_models_by_device: dict[int, dict[str, LoadedGpuModel]] = {}


def get_cuda_device_count() -> int:
    try:
        import torch

        if not torch.cuda.is_available():
            return 0
        return torch.cuda.device_count()
    except Exception:
        return 0


def get_llm_cuda_device_id(use_gpu: bool) -> int | None:
    if not use_gpu:
        return None
    return 0 if get_cuda_device_count() > 0 else None


def get_image_cuda_device_id() -> int:
    return 1 if get_cuda_device_count() >= 2 else 0


class GpuModelLease:
    def __init__(
        self,
        role: str,
        device_ids: tuple[int, ...],
        model_key: ModelKey,
        release_loaded_model: ReleaseLoadedModel,
        exclusive: bool,
    ) -> None:
        self.role = role
        self.device_ids = device_ids
        self.model_key = model_key
        self.release_loaded_model = release_loaded_model
        self.exclusive = exclusive
        self._locks: list[asyncio.Lock] = []
        self._active_device_ids: tuple[int, ...] = ()

    async def __aenter__(self) -> GpuModelLease:
        device_ids = _normalize_device_ids(self.device_ids)
        if not device_ids:
            return self
        self._active_device_ids = device_ids

        self._locks = [_get_gpu_lock(device_id) for device_id in device_ids]
        for lock in self._locks:
            await lock.acquire()
        try:
            conflicts: list[tuple[int, LoadedGpuModel]] = []
            seen_conflicts: set[int] = set()
            for device_id in device_ids:
                for current in _loaded_models_by_device.get(device_id, {}).values():
                    same_model = current.role == self.role and current.model_key == self.model_key
                    if (
                        not same_model
                        and (current.role == self.role or current.exclusive or self.exclusive)
                        and id(current) not in seen_conflicts
                    ):
                        conflicts.append((device_id, current))
                        seen_conflicts.add(id(current))

            for device_id, current in conflicts:
                await asyncio.to_thread(current.release_loaded_model, device_id)
                for loaded_device_id in current.device_ids:
                    loaded_by_role = _loaded_models_by_device.get(loaded_device_id)
                    if loaded_by_role is not None and loaded_by_role.get(current.role) is current:
                        loaded_by_role.pop(current.role, None)
                        if not loaded_by_role:
                            _loaded_models_by_device.pop(loaded_device_id, None)

            loaded = LoadedGpuModel(
                role=self.role,
                model_key=self.model_key,
                release_loaded_model=self.release_loaded_model,
                device_ids=device_ids,
                exclusive=self.exclusive,
            )
            for device_id in device_ids:
                _loaded_models_by_device.setdefault(device_id, {})[self.role] = loaded
        except Exception:
            for lock in reversed(self._locks):
                lock.release()
            self._locks = []
            self._active_device_ids = ()
            raise
        return self

    async def evict_co_resident_models(self) -> bool:
        evictions: list[tuple[int, LoadedGpuModel]] = []
        seen_models: set[int] = set()
        for device_id in self._active_device_ids:
            for current in _loaded_models_by_device.get(device_id, {}).values():
                if (
                    current.role != self.role
                    and not current.exclusive
                    and id(current) not in seen_models
                ):
                    evictions.append((device_id, current))
                    seen_models.add(id(current))

        for device_id, current in evictions:
            await asyncio.to_thread(current.release_loaded_model, device_id)
            for loaded_device_id in current.device_ids:
                loaded_by_role = _loaded_models_by_device.get(loaded_device_id)
                if loaded_by_role is not None and loaded_by_role.get(current.role) is current:
                    loaded_by_role.pop(current.role, None)
                    if not loaded_by_role:
                        _loaded_models_by_device.pop(loaded_device_id, None)
        return bool(evictions)

    async def __aexit__(
        self,
        exc_type: object,
        exc: object,
        traceback: object,
    ) -> None:
        for lock in reversed(self._locks):
            lock.release()
        self._locks = []
        self._active_device_ids = ()


def acquire_gpu_model(
    role: str,
    device_id: int | None,
    model_key: ModelKey,
    release_loaded_model: ReleaseLoadedModel,
    *,
    exclusive: bool = True,
) -> GpuModelLease:
    device_ids = () if device_id is None else (device_id,)
    return acquire_gpu_model_multi(
        role,
        device_ids,
        model_key,
        release_loaded_model,
        exclusive=exclusive,
    )


def acquire_gpu_model_multi(
    role: str,
    device_ids: tuple[int, ...],
    model_key: ModelKey,
    release_loaded_model: ReleaseLoadedModel,
    *,
    exclusive: bool = True,
) -> GpuModelLease:
    return GpuModelLease(role, device_ids, model_key, release_loaded_model, exclusive)


def _get_gpu_lock(device_id: int) -> asyncio.Lock:
    lock = _gpu_locks.get(device_id)
    if lock is None:
        lock = asyncio.Lock()
        _gpu_locks[device_id] = lock
    return lock


def _normalize_device_ids(device_ids: tuple[int, ...]) -> tuple[int, ...]:
    device_count = get_cuda_device_count()
    if device_count <= 0:
        return ()
    return tuple(
        device_id
        for device_id in sorted(set(device_ids))
        if 0 <= device_id < device_count
    )
