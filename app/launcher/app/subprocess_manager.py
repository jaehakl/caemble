from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from app.settings import LauncherSettings
from app.slave_registry import SlaveAppRegistry, load_default_registry

SendControl = Callable[[dict[str, Any]], Awaitable[None]]
CANCEL_RESET_GRACE_SECONDS = 2


@dataclass
class ManagedWorker:
    slave_app_id: str
    process: asyncio.subprocess.Process
    ready_event: asyncio.Event
    stdout_task: asyncio.Task[None]
    stderr_task: asyncio.Task[None]
    ready: bool = False
    stopping: bool = False


class WorkerManager:
    def __init__(
        self,
        settings: LauncherSettings,
        send_control: SendControl,
        registry: SlaveAppRegistry | None = None,
    ) -> None:
        self.settings = settings
        self.send_control = send_control
        self.registry = registry or load_default_registry()
        self.worker: ManagedWorker | None = None
        self.current_job_id: str | None = None
        self.worker_status = "idle"
        self.cancel_escalation_task: asyncio.Task[None] | None = None
        self.cancel_cleanup_confirmed_job_id: str | None = None
        self.cancel_terminal_forwarded_job_id: str | None = None

    def current_worker_slave_app_id(self) -> str | None:
        return self.worker.slave_app_id if self.worker is not None else None

    async def stop_all(self, reason: str) -> None:
        await self.reset_worker(reason)

    async def start_job(
        self,
        *,
        job_id: str,
        handler_type: str,
        slave_app_id: str,
        offer: dict[str, Any],
    ) -> None:
        if self.current_job_id is not None:
            await self.send_control(
                {
                    "type": "job.error",
                    "job_id": job_id,
                    "code": "launcher_busy",
                    "detail": f"launcher is busy with job {self.current_job_id}",
                }
            )
            return
        if self.registry.get(slave_app_id) is None:
            await self.send_control(
                {
                    "type": "job.error",
                    "job_id": job_id,
                    "code": "unknown_slave_app",
                    "detail": f"unknown slave app: {slave_app_id}",
                }
            )
            return

        self.current_job_id = job_id
        self.worker_status = "starting"
        self.cancel_cleanup_confirmed_job_id = None
        self.cancel_terminal_forwarded_job_id = None
        try:
            await self.ensure_worker(slave_app_id)
        except Exception as exc:
            self.current_job_id = None
            self.worker_status = "idle"
            print(
                f"[{job_id}] worker start failed: slave_app_id={slave_app_id} error={exc}",
                flush=True,
            )
            await self.send_control(
                {
                    "type": "job.error",
                    "job_id": job_id,
                    "code": "worker_start_failed",
                    "detail": str(exc),
                }
            )
            return

        if self.worker is None or self.worker.process.stdin is None:
            self.current_job_id = None
            self.worker_status = "idle"
            await self.send_control(
                {
                    "type": "job.error",
                    "job_id": job_id,
                    "code": "worker_missing",
                    "detail": "worker subprocess is not running",
                }
            )
            return

        self.worker_status = "busy"
        try:
            self.worker.process.stdin.write(
                json_line(
                    {
                        "type": "job.start",
                        "job_id": job_id,
                        "handler_type": handler_type,
                        "slave_app_id": slave_app_id,
                        "offer": offer,
                    }
                )
            )
            await self.worker.process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError) as exc:
            self.current_job_id = None
            self.worker_status = "idle"
            await self.send_control(
                {
                    "type": "job.error",
                    "job_id": job_id,
                    "code": "worker_ipc_failed",
                    "detail": str(exc),
                }
            )

    async def ensure_worker(self, slave_app_id: str) -> None:
        if self.worker is not None and self.worker.process.returncode is None and self.worker.slave_app_id == slave_app_id:
            return
        if self.worker is not None:
            await self.reset_worker("switch slave app", cancel_current_job=False, notify_reset=False)

        slave_app = self.registry.require(slave_app_id)
        if not slave_app.executable_ready:
            raise RuntimeError(f"slave executable environment is missing; run `{slave_app.install_hint}`")

        process = await asyncio.create_subprocess_exec(
            *self.registry.worker_subprocess_args(slave_app_id),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=subprocess_env(self.settings),
            cwd=slave_app.project_dir,
        )
        ready_event = asyncio.Event()
        worker = ManagedWorker(
            slave_app_id=slave_app_id,
            process=process,
            ready_event=ready_event,
            stdout_task=asyncio.create_task(self.read_worker_stdout(process, ready_event)),
            stderr_task=asyncio.create_task(self.read_worker_stderr(process)),
        )
        self.worker = worker
        self.worker_status = "starting"
        ready_timeout_seconds = self.ready_timeout_seconds_for(slave_app_id)
        try:
            await asyncio.wait_for(ready_event.wait(), timeout=ready_timeout_seconds)
        except TimeoutError as exc:
            await self.reset_worker("worker ready timeout", cancel_current_job=False, notify_reset=False)
            raise RuntimeError(f"worker did not become ready within {ready_timeout_seconds:g}s") from exc
        if not worker.ready:
            await self.reset_worker("worker startup failed", cancel_current_job=False, notify_reset=False)
            raise RuntimeError("worker exited before ready")
        self.worker_status = "idle"

    async def cancel_job(self, job_id: str, reason: str) -> None:
        if self.current_job_id != job_id:
            return
        if self.cancel_cleanup_confirmed_job_id != job_id:
            self.cancel_cleanup_confirmed_job_id = None
        if self.cancel_terminal_forwarded_job_id != job_id:
            self.cancel_terminal_forwarded_job_id = None
        if self.worker is None or self.worker.process.stdin is None or self.worker.process.returncode is not None:
            self.cancel_cancel_escalation()
            await self.send_control({"type": "job.cancelled", "job_id": job_id, "reason": reason})
            self.current_job_id = None
            self.worker_status = "idle"
            return
        self.worker_status = "cancelling"
        try:
            self.worker.process.stdin.write(json_line({"type": "job.cancel", "job_id": job_id, "reason": reason}))
            await self.worker.process.stdin.drain()
            self.cancel_cancel_escalation()
            self.cancel_escalation_task = asyncio.create_task(self.escalate_cancel(job_id, reason))
        except (BrokenPipeError, ConnectionResetError):
            await self.reset_worker(reason)

    async def reset_worker(self, reason: str, *, cancel_current_job: bool = True, notify_reset: bool = False) -> None:
        self.cancel_cancel_escalation()
        self.cancel_cleanup_confirmed_job_id = None
        self.cancel_terminal_forwarded_job_id = None
        worker = self.worker
        current_job_id = self.current_job_id if cancel_current_job else None
        self.worker = None
        if cancel_current_job:
            self.current_job_id = None
        self.worker_status = "idle"
        if worker is None:
            if current_job_id is not None:
                await self.send_control({"type": "job.cancelled", "job_id": current_job_id, "reason": reason})
            if notify_reset:
                await self.send_control({"type": "worker.reset.done"})
            return
        worker.stopping = True
        if worker.process.stdin is not None and worker.process.returncode is None:
            try:
                worker.process.stdin.write(json_line({"type": "stop", "reason": reason}))
                await worker.process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass
        try:
            await asyncio.wait_for(worker.process.wait(), timeout=3)
        except TimeoutError:
            worker.process.terminate()
            await worker.process.wait()
        worker.stdout_task.cancel()
        worker.stderr_task.cancel()
        if current_job_id is not None:
            await self.send_control({"type": "job.cancelled", "job_id": current_job_id, "reason": reason})
        if notify_reset:
            await self.send_control({"type": "worker.reset.done"})

    async def read_worker_stdout(
        self,
        process: asyncio.subprocess.Process,
        ready_event: asyncio.Event,
    ) -> None:
        try:
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                await self.handle_worker_message(json.loads(line.decode("utf-8")))
        finally:
            worker = self.worker
            if worker is not None and worker.process is process and not worker.stopping:
                if not worker.ready:
                    ready_event.set()
                failed_job_id = self.current_job_id
                terminal_was_forwarded = self.cancel_terminal_forwarded_job_id == failed_job_id
                self.worker = None
                self.current_job_id = None
                self.worker_status = "error"
                self.cancel_cancel_escalation()
                self.cancel_cleanup_confirmed_job_id = None
                self.cancel_terminal_forwarded_job_id = None
                if failed_job_id is not None and not terminal_was_forwarded:
                    await self.send_control(
                        {
                            "type": "job.error",
                            "job_id": failed_job_id,
                            "code": "worker_exit",
                            "detail": "worker subprocess exited",
                        }
                    )

    async def read_worker_stderr(self, process: asyncio.subprocess.Process) -> None:
        while True:
            line = await process.stderr.readline()
            if not line:
                break
            job_id = self.current_job_id or "worker"
            print(f"[{job_id}] {line.decode('utf-8', errors='replace').rstrip()}", flush=True)

    def ready_timeout_seconds_for(self, slave_app_id: str) -> float:
        slave_app = self.registry.get(slave_app_id)
        startup_timeout_seconds = slave_app.startup_timeout_seconds if slave_app is not None else None
        return max(self.settings.worker_ready_timeout_seconds, startup_timeout_seconds or 0)

    async def handle_worker_message(self, message: dict[str, Any]) -> None:
        message_type = message.get("type")
        if message_type == "worker.ready":
            if self.worker is not None:
                self.worker.ready = True
                self.worker.ready_event.set()
            return
        if message_type == "cae.run.cleaned":
            job_id = str(message.get("job_id") or "")
            if (
                self.current_worker_slave_app_id() == "cae"
                and self.current_job_id == job_id
            ):
                self.cancel_cleanup_confirmed_job_id = job_id
                if (
                    self.worker_status == "cancelling"
                    and self.cancel_terminal_forwarded_job_id == job_id
                ):
                    self.cancel_cancel_escalation()
                    self.current_job_id = None
                    self.worker_status = "idle"
                    self.cancel_cleanup_confirmed_job_id = None
                    self.cancel_terminal_forwarded_job_id = None
            return
        if message_type in {
            "job.answer",
            "job.running",
            "job.progress",
            "job.result",
            "job.error",
            "job.cancelled",
        }:
            await self.send_control(message)
            if message_type in {"job.result", "job.error", "job.cancelled"}:
                job_id = str(message.get("job_id") or "")
                if (
                    self.current_worker_slave_app_id() == "cae"
                    and self.current_job_id == job_id
                ):
                    self.cancel_terminal_forwarded_job_id = job_id
                    if self.cancel_cleanup_confirmed_job_id != job_id:
                        self.worker_status = "cancelling"
                        if self.cancel_escalation_task is None:
                            self.cancel_escalation_task = asyncio.create_task(
                                self.escalate_cancel(job_id, "CAE run cleanup was not confirmed")
                            )
                        return
                self.cancel_cancel_escalation()
                self.current_job_id = None
                self.worker_status = "idle"
                self.cancel_cleanup_confirmed_job_id = None
                self.cancel_terminal_forwarded_job_id = None
            return
        if message_type == "error" and self.current_job_id is not None:
            await self.send_control(
                {
                    "type": "job.error",
                    "job_id": self.current_job_id,
                    "code": str(message.get("code") or "worker_error"),
                    "detail": str(message.get("detail") or "worker error"),
                }
            )
            self.current_job_id = None
            self.worker_status = "idle"
            self.cancel_cancel_escalation()
            self.cancel_cleanup_confirmed_job_id = None
            self.cancel_terminal_forwarded_job_id = None

    async def escalate_cancel(self, job_id: str, reason: str) -> None:
        try:
            await asyncio.sleep(CANCEL_RESET_GRACE_SECONDS)
            if self.current_job_id == job_id:
                terminal_was_forwarded = self.cancel_terminal_forwarded_job_id == job_id
                await self.reset_worker(
                    f"job {job_id} did not stop within {CANCEL_RESET_GRACE_SECONDS}s: {reason}",
                    cancel_current_job=not terminal_was_forwarded,
                    notify_reset=False,
                )
                if terminal_was_forwarded:
                    self.current_job_id = None
                    self.worker_status = "idle"
        except asyncio.CancelledError:
            return
        finally:
            if self.cancel_escalation_task is asyncio.current_task():
                self.cancel_escalation_task = None

    def cancel_cancel_escalation(self) -> None:
        task = self.cancel_escalation_task
        self.cancel_escalation_task = None
        if task is not None and task is not asyncio.current_task():
            task.cancel()


def json_line(message: dict[str, Any]) -> bytes:
    return (json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8")


def subprocess_env(settings: LauncherSettings) -> dict[str, str]:
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
    env["GPSTATION_V1_RTC_ICE_SERVERS_JSON"] = settings.rtc_ice_servers_json
    if settings.rtc_ice_gather_timeout_seconds:
        env["GPSTATION_V1_RTC_ICE_GATHER_TIMEOUT_SECONDS"] = settings.rtc_ice_gather_timeout_seconds
    if settings.rtc_memory_cache_enabled:
        env["GPSTATION_V1_RTC_MEMORY_CACHE_ENABLED"] = settings.rtc_memory_cache_enabled
    return env
