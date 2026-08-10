from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import WebSocket


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class LauncherRuntime:
    id: str
    websocket: WebSocket
    access_key_id: str
    current_job_id: str | None = None
    loaded_slave_app_id: str | None = None
    worker_status: str | None = None
    resetting: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)
    last_db_heartbeat_at: float = field(default_factory=time.monotonic)
    last_db_heartbeat_status: str = "ready"
    last_access_key_check_at: float = field(default_factory=time.monotonic)


class RuntimeRegistry:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.launchers: dict[str, LauncherRuntime] = {}
        self.job_events: dict[str, asyncio.Event] = {}
        self.job_event_waiters: dict[str, int] = {}

    async def register_launcher(
        self,
        launcher_id: str,
        websocket: WebSocket,
        access_key_id: str,
    ) -> LauncherRuntime:
        launcher = LauncherRuntime(
            id=launcher_id,
            websocket=websocket,
            access_key_id=access_key_id,
        )
        async with self.lock:
            self.launchers[launcher_id] = launcher
        return launcher

    async def remove_launcher(self, launcher_id: str) -> None:
        async with self.lock:
            self.launchers.pop(launcher_id, None)

    async def get_launcher(self, launcher_id: str) -> LauncherRuntime | None:
        async with self.lock:
            return self.launchers.get(launcher_id)

    async def get_launcher_ids(self) -> set[str]:
        async with self.lock:
            return set(self.launchers)

    async def close_launchers_for_access_key(self, access_key_id: str, *, code: int = 1008) -> int:
        async with self.lock:
            targets = [
                (launcher_id, launcher.websocket)
                for launcher_id, launcher in self.launchers.items()
                if launcher.access_key_id == access_key_id
            ]
            for launcher_id, _ in targets:
                self.launchers.pop(launcher_id, None)
        closed = 0
        for _, websocket in targets:
            try:
                await websocket.close(code=code)
                closed += 1
            except Exception:
                continue
        return closed

    async def close_all_launchers(self, *, code: int = 1001) -> None:
        async with self.lock:
            targets = [launcher.websocket for launcher in self.launchers.values()]
            self.launchers.clear()
        for websocket in targets:
            try:
                await websocket.close(code=code)
            except Exception:
                continue

    async def mark_heartbeat(
        self,
        launcher_id: str,
        *,
        loaded_slave_app_id: str | None = None,
        worker_status: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        async with self.lock:
            launcher = self.launchers.get(launcher_id)
            if launcher is not None:
                launcher.loaded_slave_app_id = loaded_slave_app_id
                launcher.worker_status = worker_status
                launcher.metadata = metadata or {}

    async def mark_launcher_job(
        self,
        launcher_id: str,
        job_id: str | None,
        *,
        loaded_slave_app_id: str | None = None,
        worker_status: str | None = None,
    ) -> None:
        async with self.lock:
            launcher = self.launchers.get(launcher_id)
            if launcher is not None:
                launcher.current_job_id = job_id
                if loaded_slave_app_id is not None:
                    launcher.loaded_slave_app_id = loaded_slave_app_id
                if worker_status is not None:
                    launcher.worker_status = worker_status

    async def clear_launcher_worker(self, launcher_id: str) -> None:
        async with self.lock:
            launcher = self.launchers.get(launcher_id)
            if launcher is not None:
                launcher.current_job_id = None
                launcher.loaded_slave_app_id = None
                launcher.worker_status = "idle"
                launcher.resetting = False
                launcher.metadata = {}

    async def mark_launcher_resetting(self, launcher_id: str) -> LauncherRuntime | None:
        async with self.lock:
            launcher = self.launchers.get(launcher_id)
            if launcher is None or launcher.resetting:
                return None
            launcher.resetting = True
            launcher.worker_status = "resetting"
            return launcher

    async def launcher_snapshots(self) -> dict[str, dict[str, Any]]:
        async with self.lock:
            return {
                launcher_id: {
                    "current_job_id": launcher.current_job_id,
                    "loaded_slave_app_id": launcher.loaded_slave_app_id,
                    "worker_status": launcher.worker_status,
                    "resetting": launcher.resetting,
                    "metadata": dict(launcher.metadata),
                }
                for launcher_id, launcher in self.launchers.items()
            }

    async def idle_launcher_ids(self) -> set[str]:
        async with self.lock:
            return {
                launcher_id
                for launcher_id, launcher in self.launchers.items()
                if launcher.current_job_id is None and not launcher.resetting
            }

    async def launcher_matches_job(self, launcher_id: str, job_id: str) -> bool:
        async with self.lock:
            launcher = self.launchers.get(launcher_id)
            return launcher is not None and launcher.current_job_id == job_id

    async def heartbeat_actions(
        self,
        launcher_id: str,
        status: str,
        *,
        interval_seconds: float = 30,
    ) -> tuple[bool, bool]:
        now = time.monotonic()
        async with self.lock:
            launcher = self.launchers.get(launcher_id)
            if launcher is None:
                return False, False
            persist = (
                status != launcher.last_db_heartbeat_status
                or now - launcher.last_db_heartbeat_at >= interval_seconds
            )
            revalidate_key = now - launcher.last_access_key_check_at >= interval_seconds
            if persist:
                launcher.last_db_heartbeat_status = status
                launcher.last_db_heartbeat_at = now
            if revalidate_key:
                launcher.last_access_key_check_at = now
            return persist, revalidate_key

    async def access_key_revalidation_targets(
        self,
        *,
        interval_seconds: float = 30,
    ) -> list[tuple[str, str]]:
        now = time.monotonic()
        async with self.lock:
            return [
                (launcher_id, launcher.access_key_id)
                for launcher_id, launcher in self.launchers.items()
                if now - launcher.last_access_key_check_at >= interval_seconds
            ]

    async def mark_access_keys_revalidated(self, launcher_ids: set[str]) -> None:
        now = time.monotonic()
        async with self.lock:
            for launcher_id in launcher_ids:
                launcher = self.launchers.get(launcher_id)
                if launcher is not None:
                    launcher.last_access_key_check_at = now

    async def set_job_event(self, job_id: str) -> None:
        async with self.lock:
            event = self.job_events.get(job_id)
            if event is not None:
                event.set()

    async def prepare_job_wait(self, job_id: str) -> asyncio.Event:
        async with self.lock:
            event = self.job_events.get(job_id)
            if event is None:
                event = asyncio.Event()
                self.job_events[job_id] = event
                self.job_event_waiters[job_id] = 0
            self.job_event_waiters[job_id] = self.job_event_waiters.get(job_id, 0) + 1
            return event

    async def wait_prepared_job_event(self, job_id: str, event: asyncio.Event, timeout: float) -> None:
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
        except TimeoutError:
            pass
        finally:
            await self.release_prepared_job_event(job_id, event)

    async def release_prepared_job_event(self, job_id: str, event: asyncio.Event) -> None:
        async with self.lock:
            remaining = max(0, self.job_event_waiters.get(job_id, 1) - 1)
            if remaining == 0:
                self.job_event_waiters.pop(job_id, None)
                if self.job_events.get(job_id) is event:
                    self.job_events.pop(job_id, None)
            else:
                self.job_event_waiters[job_id] = remaining


runtime = RuntimeRegistry()
