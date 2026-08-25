from __future__ import annotations

import asyncio
import json
from typing import Any

import websockets
from sdk.protocol.messages import (
    ControlError,
    JobCancel,
    JobStart,
    LauncherAccepted,
    WorkerReset,
    parse_server_message,
)

from app.settings import LauncherSettings
from app.slave_registry import SlaveAppRegistry, load_default_registry
from app.subprocess_manager import WorkerManager

BACKOFF_SECONDS = [1, 2, 5, 10, 30]


async def run_slave_launcher(settings: LauncherSettings) -> None:
    attempt = 0
    while True:
        delay = BACKOFF_SECONDS[min(attempt, len(BACKOFF_SECONDS) - 1)]
        try:
            await run_connection(settings)
            attempt = 0
        except asyncio.CancelledError:
            raise
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            attempt += 1
            print(f"Control connection failed: {exc}")
            print(f"Reconnecting in {delay}s...")
            await asyncio.sleep(delay)


async def run_connection(settings: LauncherSettings) -> None:
    headers = {"Authorization": f"Bearer {settings.access_token}"}
    async with await open_websocket(settings.control_websocket_url, headers) as websocket:
        send_lock = asyncio.Lock()
        registry = load_default_registry()
        manager: WorkerManager | None = None
        heartbeat_task: asyncio.Task[None] | None = None
        try:
            await send_json(
                websocket,
                send_lock,
                launcher_hello_payload(settings, registry),
            )
            accepted = parse_server_message(json.loads(await websocket.recv()))
            if not isinstance(accepted, LauncherAccepted):
                raise RuntimeError(f"Expected launcher.accepted, received {accepted.type}")
            print(f"Launcher connection: {accepted.launcher_id}", flush=True)
            print_slave_environment_status(registry)
            manager = WorkerManager(
                settings,
                lambda message: send_json(websocket, send_lock, message),
                registry,
            )
            heartbeat_task = asyncio.create_task(send_heartbeats(websocket, send_lock, manager, settings))

            async for raw_message in websocket:
                await handle_server_message(manager, json.loads(raw_message))
        finally:
            if heartbeat_task is not None:
                heartbeat_task.cancel()
            if manager is not None:
                await manager.stop_all("launcher shutdown")
            if heartbeat_task is not None:
                try:
                    await heartbeat_task
                except asyncio.CancelledError:
                    pass


async def open_websocket(url: str, headers: dict[str, str]) -> Any:
    try:
        return websockets.connect(url, additional_headers=headers)
    except TypeError:
        return websockets.connect(url, extra_headers=headers)


async def send_json(websocket: Any, send_lock: asyncio.Lock, message: dict[str, Any]) -> None:
    async with send_lock:
        await websocket.send(json.dumps(message, ensure_ascii=False))


async def send_heartbeats(
    websocket: Any,
    send_lock: asyncio.Lock,
    manager: WorkerManager,
    settings: LauncherSettings,
) -> None:
    while True:
        await asyncio.sleep(settings.heartbeat_interval_seconds)
        await send_json(
            websocket,
            send_lock,
            {
                "type": "launcher.heartbeat",
                "status": "busy" if manager.current_job_id else "ready",
                "current_job_id": manager.current_job_id,
                "loaded_slave_app_id": manager.current_worker_slave_app_id(),
                "worker_status": manager.worker_status,
                "metadata": {},
            },
        )


async def handle_server_message(manager: WorkerManager, value: Any) -> None:
    message = parse_server_message(value)
    if isinstance(message, JobStart):
        await manager.start_job(
            job_id=message.job_id,
            handler_type=message.handler_type,
            slave_app_id=message.slave_app_id,
            offer=message.offer.model_dump(exclude_none=True),
        )
        return
    if isinstance(message, JobCancel):
        await manager.cancel_job(message.job_id, message.reason)
        return
    if isinstance(message, WorkerReset):
        await manager.reset_worker(message.reason, notify_reset=True)
        return
    if isinstance(message, ControlError):
        print(f"Server control error: {message.detail}", flush=True)
        return
    raise RuntimeError(f"Unexpected server message after handshake: {message.type}")


def print_slave_environment_status(registry: SlaveAppRegistry) -> None:
    for slave_app_id in registry.ids():
        slave_app = registry.require(slave_app_id)
        if slave_app.executable_ready:
            print(
                f"[slave:{slave_app_id}] environment ready: {slave_app.python_executable}",
                flush=True,
            )
        else:
            print(
                f"[slave:{slave_app_id}] environment missing: {slave_app.python_executable}; "
                f"run `{slave_app.install_hint}`",
                flush=True,
            )


def launcher_hello_payload(settings: LauncherSettings, registry: SlaveAppRegistry) -> dict[str, Any]:
    slave_app_ids = [
        slave_app_id
        for slave_app_id in registry.ids()
        if registry.require(slave_app_id).executable_ready
    ]
    return {
        "type": "launcher.hello",
        "launcher_name": settings.launcher_name,
        "slave_app_ids": slave_app_ids,
        "metadata": registry.metadata(slave_app_ids),
    }
