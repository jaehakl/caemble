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
    boot_id: str = ""
    session_id: str = ""
    instances: dict[str, dict[str, Any]] = field(default_factory=dict)
    resources: dict[str, Any] = field(default_factory=dict)
    connected: bool = True
    recovering: bool = True
    rejected: dict[str, int] = field(default_factory=dict)
    last_command_at: dict[str, float] = field(default_factory=dict)
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
        *, boot_id: str = "", session_id: str = "", instances: list[dict] | None = None, resources: dict | None = None,
    ) -> LauncherRuntime:
        launcher = LauncherRuntime(
            id=launcher_id,
            websocket=websocket,
            access_key_id=access_key_id, boot_id=boot_id, session_id=session_id,
            instances={item["instance_id"]: item for item in (instances or []) if item.get("instance_id")},
            resources=resources or {},
        )
        async with self.lock:
            self.launchers[launcher_id] = launcher
        return launcher

    async def remove_launcher(self, launcher_id: str, session_id: str | None = None) -> None:
        async with self.lock:
            current = self.launchers.get(launcher_id)
            if current is not None and (session_id is None or current.session_id == session_id):
                self.launchers.pop(launcher_id, None)

    async def suspend_launcher(self, launcher_id: str, session_id: str) -> bool:
        async with self.lock:
            current = self.launchers.get(launcher_id)
            if current is None or current.session_id != session_id:
                return False
            current.connected = False
            current.recovering = True
            return True

    async def session_matches(self, launcher_id: str, session_id: str) -> bool:
        async with self.lock:
            current = self.launchers.get(launcher_id)
            return current is not None and current.session_id == session_id and current.connected


    async def get_launcher(self, launcher_id: str) -> LauncherRuntime | None:
        async with self.lock:
            return self.launchers.get(launcher_id)

    async def get_launcher_ids(self) -> set[str]:
        async with self.lock:
            return {key for key, value in self.launchers.items() if value.connected}

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

    async def mark_heartbeat(self, launcher_id: str, *, instances: list[dict] | None = None,
                             resources: dict | None = None, metadata: dict | None = None) -> None:
        async with self.lock:
            launcher = self.launchers.get(launcher_id)
            if launcher is not None:
                # Keep pending API offers until an explicit response resolves them.
                pending = {key: item for key, item in launcher.instances.items() if item.get("state") == "reserving"}
                launcher.instances = {**pending, **{item["instance_id"]: item for item in (instances or []) if item.get("instance_id")}}
                launcher.resources = resources or {}
                launcher.metadata = metadata or {}

    async def mark_instance(self, launcher_id: str, instance: dict) -> None:
        async with self.lock:
            launcher = self.launchers.get(launcher_id)
            if launcher is not None:
                launcher.instances[instance["instance_id"]] = instance

    async def remove_instance(self, launcher_id: str, instance_id: str, reservation_id: str) -> None:
        async with self.lock:
            launcher = self.launchers.get(launcher_id)
            if launcher is not None:
                instance = launcher.instances.get(instance_id)
                if instance and instance.get("reservation_id") == reservation_id:
                    launcher.instances.pop(instance_id)
                    launcher.last_command_at.pop(reservation_id, None)

    async def launcher_snapshots(self) -> dict[str, dict[str, Any]]:
        async with self.lock:
            return {key: {"boot_id": value.boot_id, "session_id": value.session_id,
                          "connected": value.connected, "recovering": value.recovering,
                          "instances": [{**item, "state": item.get("state", item.get("status", "unknown"))} for item in value.instances.values()], "resources": dict(value.resources),
                          "metadata": dict(value.metadata)} for key, value in self.launchers.items()}

    async def available_launchers(self) -> dict[str, dict[str, Any]]:
        async with self.lock:
            return {key: {"resources": dict(value.resources), "boot_id": value.boot_id,
                          "rejected": dict(value.rejected)} for key, value in self.launchers.items()
                    if value.connected and not value.recovering
                    and not any(item.get("state") == "reserving" for item in value.instances.values())}

    async def launcher_matches_job(self, launcher_id: str, job_id: str, reservation_id: str | None = None) -> bool:
        async with self.lock:
            launcher = self.launchers.get(launcher_id)
            return launcher is not None and any(item.get("job_id") == job_id and
                (reservation_id is None or item.get("reservation_id") == reservation_id)
                for item in launcher.instances.values())

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
