from __future__ import annotations

import asyncio
import inspect
import json
from typing import Any
from uuid import uuid4

import websockets
from sdk.protocol.messages import parse_server_message

from app.journal import LauncherJournal
from app.settings import LauncherSettings
from app.slave_registry import SlaveAppRegistry
from app.subprocess_manager import WorkerManager

BACKOFF_SECONDS = [1, 2, 5, 10, 30]


class ControlConnection:
    """Transport can disappear while process ownership and cleanup continue."""
    def __init__(self) -> None:
        self.websocket = None
        self.session_id: str | None = None
        self.send_lock = asyncio.Lock()
        self.pending: dict[tuple[str, str], dict[str, Any]] = {}

    async def send(self, message: dict[str, Any]) -> None:
        async with self.send_lock:
            if self.websocket is not None:
                try:
                    await self.websocket.send(json.dumps({**message, "session_id": self.session_id}, ensure_ascii=False))
                    return
                except (OSError, websockets.ConnectionClosed):
                    self.websocket = None
            if message["type"] == "launcher.heartbeat":
                return  # Reconnect sends a fresh inventory; never replay an old snapshot.
            self.pending[(str(message.get("instance_id", "")), message["type"])] = message

    async def flush(self) -> None:
        messages = list(self.pending.values())
        self.pending.clear()
        for message in messages:
            await self.send(message)


async def run_slave_launcher(settings: LauncherSettings) -> None:
    connection = ControlConnection()
    manager = WorkerManager(settings, connection.send, journal=LauncherJournal(settings.state_dir))
    grace_task: asyncio.Task | None = None
    attempt = 0
    try:
        await manager.initialize()
        await asyncio.to_thread(manager.registry.prepare)
        while True:
            try:
                await run_connection(settings, manager, connection,
                                     on_connected=lambda: grace_task.cancel() if grace_task is not None and not manager.stopping else None)
                attempt = 0
            except asyncio.CancelledError:
                raise
            except Exception as error:
                print(f"Control connection failed: {error}", flush=True)
                attempt += 1
            finally:
                connection.websocket = None
            if grace_task is None or grace_task.done():
                grace_task = asyncio.create_task(expire_control_grace(manager, settings.control_grace_seconds))
            delay = BACKOFF_SECONDS[min(attempt, len(BACKOFF_SECONDS) - 1)]
            await asyncio.sleep(delay)
    finally:
        if grace_task is not None:
            grace_task.cancel()
            await asyncio.gather(grace_task, return_exceptions=True)
        await manager.close()


async def expire_control_grace(manager: WorkerManager, seconds: float) -> None:
    await asyncio.sleep(seconds)
    await manager.stop_all("control connection grace expired")


async def run_connection(settings: LauncherSettings, manager: WorkerManager,
                         connection: ControlConnection, on_connected=lambda: None) -> None:
    headers = {"Authorization": f"Bearer {settings.access_token}"}
    session_id = str(uuid4())
    async with open_websocket(settings.control_websocket_url, headers) as websocket:
        ready_ids = await asyncio.to_thread(manager.registry.ready_ids)
        await websocket.send(json.dumps(launcher_hello_payload(settings, manager.registry, manager, session_id, ready_ids), ensure_ascii=False))
        accepted = parse_server_message(json.loads(await websocket.recv()))
        if accepted.type != "launcher.accepted" or accepted.boot_id != manager.boot_id or accepted.session_id != session_id:
            raise RuntimeError("Invalid execution protocol handshake")
        if manager.launcher_id is not None and manager.launcher_id != accepted.launcher_id:
            raise RuntimeError("Server changed launcher identity during the same boot")
        manager.launcher_id = accepted.launcher_id
        on_connected()
        if manager.stopping:
            await manager.stop_all("finishing expired control grace cleanup")
        if not manager.instances:
            manager.stopping = False
        connection.websocket, connection.session_id = websocket, session_id
        print(f"Launcher connection: {accepted.launcher_id} boot={manager.boot_id} session={session_id}", flush=True)
        await connection.flush()
        heartbeat = asyncio.create_task(send_heartbeats(connection, manager, settings))
        try:
            async for raw_message in websocket:
                value = json.loads(raw_message)
                if value.get("session_id") != session_id:
                    continue
                await handle_server_message(manager, value)
        finally:
            connection.websocket = None
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)


def open_websocket(url: str, headers: dict[str, str]) -> Any:
    keyword = "additional_headers" if "additional_headers" in inspect.signature(websockets.connect).parameters else "extra_headers"
    return websockets.connect(url, **{keyword: headers})


async def send_heartbeats(connection: ControlConnection, manager: WorkerManager, settings: LauncherSettings) -> None:
    while True:
        await asyncio.sleep(settings.heartbeat_interval_seconds)
        await connection.send({"type": "launcher.heartbeat", "boot_id": manager.boot_id,
                               "status": "recovering" if manager.stopping else "busy" if manager.instances else "ready",
                               "instances": manager.inventory(), "resources": manager.resource_report(),
                               "cleanup_receipts": list(manager.receipts.values()), "metadata": {}})


async def handle_server_message(manager: WorkerManager, value: Any) -> None:
    message = parse_server_message(value).model_dump(exclude_none=True)
    message_type = message["type"]
    if message_type == "job.reserve":
        await manager.reserve_job(message)
    elif message_type == "job.start":
        await manager.start_job(message)
    elif message_type in {"job.cancel", "worker.reset"}:
        await manager.cancel_job(message)
    elif message_type == "job.cleaned.ack":
        await manager.acknowledge_cleanup(message)
    elif message_type == "launcher.stop_all" and message["boot_id"] == manager.boot_id:
        # Stop in a task so the control loop can still receive acknowledgements.
        asyncio.create_task(manager.stop_all(message["reason"]))
    elif message_type == "error":
        print(f"Server control error: {message['detail']}", flush=True)


def launcher_hello_payload(settings: LauncherSettings, registry: SlaveAppRegistry,
                           manager: WorkerManager, session_id: str, ready_ids: list[str] | None = None) -> dict[str, Any]:
    ids = ready_ids if ready_ids is not None else registry.ready_ids()
    return {"type": "launcher.hello", "execution_protocol": 2, "launcher_name": settings.launcher_name,
            "installation_id": manager.installation_id, "boot_id": manager.boot_id, "session_id": session_id,
            "slave_app_ids": ids, "job_modes": {app_id: registry.require(app_id).job_mode for app_id in ids},
            "storage_versions": {app_id: registry.require(app_id).storage_version for app_id in ids
                                 if registry.require(app_id).storage_version is not None},
            "metadata": registry.metadata(ids), "instances": manager.inventory(),
            "resources": manager.resource_report(), "cleanup_receipts": list(manager.receipts.values())}
