from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from uuid import uuid4

import psutil
from sdk.protocol.execution import ExecutionIdentity

from app.containment import ProcessContainer, recover_container
from sdk.gpu_memory import GpuProcessMonitor
from app.journal import LauncherJournal
from app.resources import ResourceLedger, ResourcePolicy, discover_gpus
from app.settings import LauncherSettings
from app.slave_registry import SlaveAppRegistry, load_default_registry
from app.worker_env import json_line, subprocess_env

SendControl = Callable[[dict[str, Any]], Awaitable[None]]
IDENTITY_FIELDS = tuple(ExecutionIdentity.model_fields)
TERMINAL_MESSAGES = {"job.result", "job.error", "job.cancelled"}


@dataclass
class ManagedWorker:
    identity: dict[str, Any]
    slave_app_id: str
    handler_type: str
    job_mode: str
    allocation: dict[str, Any]
    status: str = "reserved"
    container: ProcessContainer | None = None
    process: asyncio.subprocess.Process | None = None
    ready_event: asyncio.Event = field(default_factory=asyncio.Event)
    ready: bool = False
    terminal: dict[str, Any] | None = None
    start_task: asyncio.Task | None = None
    cleanup_task: asyncio.Task | None = None
    stdout_task: asyncio.Task | None = None
    stderr_task: asyncio.Task | None = None
    vram_used_bytes: dict[str, int] | None = None
    vram_valid_at: float = field(default_factory=time.monotonic)
    vram_monitoring_warning: str | None = None


class WorkerManager:
    def __init__(self, settings: LauncherSettings, send_control: SendControl,
                 registry: SlaveAppRegistry | None = None, *, ledger: ResourceLedger | None = None,
                 journal: LauncherJournal | None = None, container_factory=ProcessContainer) -> None:
        self.settings, self.send_control = settings, send_control
        self.registry = registry or load_default_registry()
        self.ledger = ledger or ResourceLedger(ResourcePolicy.load(settings.resources_file, settings.cae_cpu_budget))
        self.journal = journal
        self.container_factory = container_factory
        self.installation_id = journal.data["installation_id"] if journal else str(uuid4())
        self.boot_id = str(uuid4())
        self.launcher_id: str | None = None
        self.owner_id: str | None = None
        self.instances: dict[str, ManagedWorker] = {}
        self.receipts: dict[str, dict[str, Any]] = dict(journal.data["cleanup_receipts"]) if journal else {}
        self.completed: dict[str, dict[str, Any]] = {}
        self.metric_task: asyncio.Task | None = None
        self.stopping = False
        self.gpu_monitor = GpuProcessMonitor()
        self.gpu_valid_at = time.monotonic()
        self.gpu_monitoring_warning: str | None = None

    async def initialize(self) -> None:
        if self.journal is not None:
            for instance_id, entry in list(self.journal.data["instances"].items()):
                await recover_container(entry.get("container") or {})
                self.receipts[instance_id] = {"type": "job.cleaned", **entry["identity"],
                                             **({"terminal": entry["terminal"]} if entry.get("terminal") else {})}
                self.journal.data["instances"].pop(instance_id)
            self.journal.data["cleanup_receipts"] = self.receipts
            self.journal.save()
        await self.sample_resources()
        self.metric_task = asyncio.create_task(self.monitor_resources())

    def inventory(self) -> list[dict[str, Any]]:
        return [{**worker.identity, "slave_app_id": worker.slave_app_id, "handler_type": worker.handler_type,
                 "job_mode": worker.job_mode, "status": worker.status, "allocation": worker.allocation,
                 "ram_used_bytes": self.ledger.reservations[worker.identity["instance_id"]].rss,
                 "vram_used_bytes": worker.vram_used_bytes,
                 "vram_monitoring_status": "healthy" if worker.vram_used_bytes is not None else "unavailable",
                 "vram_monitoring_warning": worker.vram_monitoring_warning}
                for worker in self.instances.values()]

    def resource_report(self) -> dict[str, Any]:
        report = self.ledger.report(self.registry.ids())
        report["vram_monitoring_status"] = "healthy" if self.ledger.gpu_process_metrics_complete else "unavailable"
        report["vram_monitoring_warning"] = self.gpu_monitoring_warning
        for device in report["gpu_devices"]:
            owners = [self.instances[owner] for owner in device["instance_ids"] if owner in self.instances]
            device["vram_used_bytes"] = (sum(worker.vram_used_bytes.get(device["uuid"], 0) for worker in owners)
                                         if all(worker.vram_used_bytes is not None for worker in owners) else None)
            device["vram_monitoring_warning"] = self.gpu_monitoring_warning
            device["vram_monitoring_status"] = report["vram_monitoring_status"]
        if self.stopping:
            report["admission_open"] = False
        return report

    def persist_worker(self, worker: ManagedWorker) -> None:
        if self.journal is not None:
            self.journal.data["instances"][worker.identity["instance_id"]] = {
                "identity": worker.identity,
                "container": worker.container.journal_state() if worker.container else {},
                "terminal": worker.terminal,
            }
            self.journal.save()

    async def reserve_job(self, message: dict[str, Any]) -> None:
        identity = {key: message[key] for key in IDENTITY_FIELDS}
        instance_id = identity["instance_id"]
        async with self.ledger.lock:
            reason = None
            existing = self.instances.get(instance_id)
            app = self.registry.get(message["slave_app_id"])
            if identity["boot_id"] != self.boot_id or identity["launcher_id"] != self.launcher_id:
                reason = "execution_identity_mismatch"
            elif existing is not None:
                if existing.identity != identity:
                    reason = "instance_identity_conflict"
                elif (existing.slave_app_id != message["slave_app_id"] or existing.handler_type != message["handler_type"]
                      or existing.job_mode != message["job_mode"]):
                    reason = "reservation_mismatch"
                else:
                    response = {"type": "job.reserved", **identity, "allocation": existing.allocation}
            elif instance_id in self.receipts or instance_id in self.completed:
                receipt = self.receipts.get(instance_id) or self.completed[instance_id]
                if all(receipt[key] == identity[key] for key in IDENTITY_FIELDS):
                    response = receipt
                else:
                    reason = "instance_identity_conflict"
            elif self.stopping:
                reason = "launcher_stopping"
            elif any(receipt["attempt_id"] == identity["attempt_id"] or receipt["reservation_id"] == identity["reservation_id"]
                     for receipt in (*self.receipts.values(), *self.completed.values())):
                reason = "execution_already_cleaned"
            elif any(worker.identity["attempt_id"] == identity["attempt_id"] or worker.identity["job_id"] == identity["job_id"]
                     or worker.identity["reservation_id"] == identity["reservation_id"] for worker in self.instances.values()):
                reason = "execution_already_reserved"
            elif app is None:
                reason = "unknown_slave_app"
            elif app.job_mode != message["job_mode"]:
                reason = "job_mode_mismatch"
            else:
                allocation, reason = self.ledger.reserve(instance_id, app.id, message.get("resources") or {},
                    message["handler_type"], resolved=message.get("resources_resolved", False))
                if allocation is not None:
                    worker = ManagedWorker(identity, app.id, message["handler_type"], app.job_mode, allocation)
                    self.instances[instance_id] = worker
                    self.persist_worker(worker)
                    response = {"type": "job.reserved", **identity, "allocation": allocation}
            if reason is not None:
                response = {"type": "job.rejected", **identity, "reason": reason, "resource_revision": self.ledger.revision}
        await self.send_control(response)

    def matching_worker(self, message: dict[str, Any]) -> ManagedWorker | None:
        worker = self.instances.get(message.get("instance_id"))
        return worker if worker is not None and all(message.get(key) == value for key, value in worker.identity.items()) else None

    async def start_job(self, message: dict[str, Any]) -> None:
        worker = self.matching_worker(message)
        if worker is None:
            receipt = self.receipts.get(message.get("instance_id"))
            if receipt and all(message.get(key) == receipt[key] for key in IDENTITY_FIELDS):
                await self.send_control(receipt)
            return
        if (worker.allocation != message.get("allocation") or worker.slave_app_id != message.get("slave_app_id")
                or worker.handler_type != message.get("handler_type") or worker.job_mode != message.get("job_mode")):
            return
        if worker.status != "reserved":
            return
        worker.status = "starting"
        worker.start_task = asyncio.create_task(self.launch_worker(worker, message))

    async def launch_worker(self, worker: ManagedWorker, assignment: dict[str, Any]) -> None:
        try:
            app = self.registry.require(worker.slave_app_id)
            await asyncio.to_thread(app.check_ready)
            if worker.status == "cleaning":
                return
            worker.container = self.container_factory()
            worker.process = await worker.container.start(
                [str(app.python_executable), "-m", "sdk.slave.bootstrap", "--module", app.module, "--worker"],
                env=subprocess_env(self.settings, {"identity": worker.identity, "allocation": worker.allocation},
                                   owner_id=self.owner_id),
                cwd=app.project_dir, cpu_ids=worker.allocation["cpu_ids"],
            )
            self.persist_worker(worker)
            worker.stdout_task = asyncio.create_task(self.read_worker_stdout(worker))
            worker.stderr_task = asyncio.create_task(self.read_worker_stderr(worker))
            if worker.status == "cleaning":
                return
            await self.write_worker(worker, {"type": "bootstrap.start"})
            timeout = max(self.settings.worker_ready_timeout_seconds, app.startup_timeout_seconds or 0)
            await asyncio.wait_for(worker.ready_event.wait(), timeout)
            if worker.status == "cleaning":
                return
            if not worker.ready:
                raise RuntimeError("worker exited before becoming ready")
            worker.status = "started"
            await self.write_worker(worker, {key: value for key, value in assignment.items() if key != "session_id"})
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await self.emit_terminal(worker, {"type": "job.error", "code": "worker_start_failed", "detail": str(error)})
            self.schedule_cleanup(worker)

    async def write_worker(self, worker: ManagedWorker, message: dict[str, Any]) -> None:
        if worker.process is None or worker.process.stdin is None:
            raise RuntimeError("worker stdin is unavailable")
        worker.process.stdin.write(json_line(message))
        await worker.process.stdin.drain()

    async def read_worker_stdout(self, worker: ManagedWorker) -> None:
        try:
            while True:
                line = await worker.process.stdout.readline()
                if not line:
                    break
                await self.handle_worker_message(worker, json.loads(line.decode("utf-8")))
        except (ValueError, UnicodeError, OSError) as error:
            await self.emit_terminal(worker, {"type": "job.error", "code": "worker_ipc_failed", "detail": str(error)})
        finally:
            worker.ready_event.set()
            if worker.status != "cleaning":
                if worker.terminal is None:
                    await self.emit_terminal(worker, {"type": "job.error", "code": "worker_exit", "detail": "worker process exited"})
                self.schedule_cleanup(worker)

    async def read_worker_stderr(self, worker: ManagedWorker) -> None:
        while True:
            line = await worker.process.stderr.readline()
            if not line:
                return
            identity = worker.identity
            print(f"[{identity['instance_id']} {identity['job_id']} attempt={identity['attempt_count']}] "
                  f"{line.decode('utf-8', errors='replace').rstrip()}", flush=True)

    async def handle_worker_message(self, worker: ManagedWorker, message: dict[str, Any]) -> None:
        if self.instances.get(worker.identity["instance_id"]) is not worker:
            return
        message_type = message.get("type")
        if message_type == "worker.ready":
            worker.ready = True
            worker.ready_event.set()
            return
        if message_type == "error":
            await self.emit_terminal(worker, {"type": "job.error", "code": message.get("code", "worker_error"),
                                              "detail": message.get("detail", "worker error")})
            self.schedule_cleanup(worker)
            return
        if not all(message.get(key) == value for key, value in worker.identity.items()):
            return
        if message_type == "job.cleaned":
            self.schedule_cleanup(worker)
        elif message_type in TERMINAL_MESSAGES:
            await self.emit_terminal(worker, message)
            self.schedule_cleanup(worker)
        elif message_type in {"job.answer", "job.running", "job.progress"} and worker.terminal is None:
            if message_type == "job.running":
                async with self.ledger.lock:
                    if (self.instances.get(worker.identity["instance_id"]) is not worker
                            or worker.terminal is not None or worker.status in {"cleaning", "cleanup_failed"}):
                        return
                    worker.status = "running"
                    self.ledger.mark_running(worker.identity["instance_id"])
            await self.send_control(message)

    async def emit_terminal(self, worker: ManagedWorker, message: dict[str, Any], *, stop_immediately: bool = False) -> None:
        if worker.terminal is None:
            worker.terminal = {**message, **worker.identity}
            self.persist_worker(worker)
            if stop_immediately:
                if worker.start_task is not None and not worker.start_task.done():
                    worker.start_task.cancel()
                self.schedule_cleanup(worker, grace=0)
            await self.send_control(worker.terminal)

    def schedule_cleanup(self, worker: ManagedWorker, grace: float = 3.0) -> None:
        if worker.cleanup_task is None or (worker.cleanup_task.done() and worker.status == "cleanup_failed"):
            worker.status = "cleaning"
            worker.ready_event.set()
            worker.cleanup_task = asyncio.create_task(self.cleanup_worker(worker, grace))

    async def cleanup_worker(self, worker: ManagedWorker, grace: float) -> None:
        try:
            if worker.start_task is not None and worker.start_task is not asyncio.current_task():
                await asyncio.gather(worker.start_task, return_exceptions=True)
            if grace > 0 and worker.process is not None and worker.process.returncode is None:
                try:
                    await self.write_worker(worker, {"type": "stop", **worker.identity, "reason": "attempt cleanup"})
                    worker.process.stdin.close()
                except (BrokenPipeError, ConnectionResetError):
                    pass
            if worker.container is not None:
                await worker.container.stop(grace)
            for task in (worker.stdout_task, worker.stderr_task):
                if task is not None and task is not asyncio.current_task():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            receipt = {"type": "job.cleaned", **worker.identity,
                       **({"terminal": worker.terminal} if worker.terminal else {})}
            async with self.ledger.lock:
                instance_id = worker.identity["instance_id"]
                self.receipts[instance_id] = receipt
                if self.journal is not None:
                    self.journal.data["instances"].pop(instance_id, None)
                    self.journal.data["cleanup_receipts"] = self.receipts
                    self.journal.save()
                self.ledger.release(instance_id)
                self.instances.pop(instance_id, None)
            await self.send_control({key: value for key, value in receipt.items() if key != "terminal"})
        except Exception as error:
            worker.status = "cleanup_failed"
            print(f"[{worker.identity['instance_id']}] cleanup unconfirmed; reservation retained: {error}", flush=True)

    async def cancel_job(self, message: dict[str, Any]) -> None:
        worker = self.matching_worker(message)
        if worker is None:
            receipt = self.receipts.get(message.get("instance_id"))
            if receipt is not None and all(message.get(key) == receipt[key] for key in IDENTITY_FIELDS):
                await self.send_control(receipt)
            return
        if worker.process is not None and worker.process.returncode is None:
            try:
                await self.write_worker(worker, {"type": "job.cancel", **worker.identity, "reason": message.get("reason", "cancelled")})
            except (BrokenPipeError, ConnectionResetError):
                pass
        await self.emit_terminal(worker, {"type": "job.cancelled", "reason": message.get("reason", "cancelled")})
        self.schedule_cleanup(worker)

    async def acknowledge_cleanup(self, message: dict[str, Any]) -> None:
        receipt = self.receipts.get(message.get("instance_id"))
        if receipt is not None and all(message.get(key) == receipt[key] for key in IDENTITY_FIELDS):
            self.receipts.pop(message["instance_id"])
            self.completed[message["instance_id"]] = receipt
            if self.journal is not None:
                self.journal.data["cleanup_receipts"] = self.receipts
                self.journal.save()

    async def stop_all(self, reason: str) -> None:
        self.stopping = True
        for worker in list(self.instances.values()):
            await self.cancel_job({**worker.identity, "reason": reason})
        await asyncio.gather(*(asyncio.shield(worker.cleanup_task) for worker in list(self.instances.values()) if worker.cleanup_task), return_exceptions=True)

    async def close(self) -> None:
        await self.stop_all("launcher shutdown")
        if self.metric_task is not None:
            self.metric_task.cancel()
            await asyncio.gather(self.metric_task, return_exceptions=True)
        await asyncio.to_thread(self.gpu_monitor.close)
        if self.journal is not None:
            self.journal.close()

    async def sample_resources(self) -> None:
        # Capture process lifetimes, not only PIDs: children may exit/reuse a PID
        # while the OS GPU query is in flight.
        captured = {}
        for instance_id, worker in list(self.instances.items()):
            try:
                captured[instance_id] = (worker.container, process_identities(worker.container))
            except (psutil.Error, OSError):
                captured[instance_id] = (worker.container, None)
        gpu_sample_started_at = time.monotonic()
        gpus = None
        process_usage = None
        try:
            gpus = await asyncio.to_thread(discover_gpus)
            process_usage = await asyncio.to_thread(self.gpu_monitor.sample,
                [gpu["uuid"] for gpu in self.ledger.selected_gpus(gpus)])
        except Exception:
            # Keep device telemetry if only per-process telemetry failed.
            pass
        exceeded = []
        async with self.ledger.lock:
            complete = True
            current_time = time.monotonic()
            fresh = current_time - gpu_sample_started_at <= self.ledger.policy.metrics_max_age_seconds
            process_complete = process_usage is not None and gpus is not None and fresh
            rss = {}
            for instance_id, worker in self.instances.items():
                try:
                    rss[instance_id] = worker.container.rss() if worker.container is not None else 0
                except (psutil.Error, OSError):
                    complete = False
                devices = worker.allocation["gpu_devices"]
                if not devices:
                    continue
                before_container, before_pids = captured.get(instance_id, (None, None))
                try:
                    after_pids = process_identities(worker.container)
                except (psutil.Error, OSError):
                    after_pids = None
                valid = (fresh and process_usage is not None and before_pids is not None
                         and before_container is worker.container and before_pids == after_pids
                         and set(devices).issubset(process_usage))
                if valid:
                    worker.vram_used_bytes = {device: sum(process_usage[device].get(pid, 0) for pid in after_pids)
                                              for device in devices}
                    worker.vram_valid_at = gpu_sample_started_at
                    if worker.terminal is None and any(worker.vram_used_bytes[device] >= budget
                            for device, budget in worker.allocation["vram_budget_bytes"].items()):
                        exceeded.append(worker)
                else:
                    worker.vram_used_bytes = None
                    process_complete = False
                warning = ("GPU 메모리 감시 불가: 작업은 계속 실행되지만 예산 초과를 확인할 수 없습니다."
                           if current_time - worker.vram_valid_at > self.ledger.policy.metrics_max_age_seconds else None)
                if warning != worker.vram_monitoring_warning:
                    print(f"[{instance_id}] {warning or 'GPU 메모리 감시 복구'}", flush=True)
                    worker.vram_monitoring_warning = warning
            if process_complete:
                self.gpu_valid_at = gpu_sample_started_at
            warning = ("GPU 메모리 감시 불가: 신규 GPU 배정을 중단했습니다. 기존 작업은 계속 실행됩니다."
                       if current_time - self.gpu_valid_at > self.ledger.policy.metrics_max_age_seconds else None)
            if warning != self.gpu_monitoring_warning:
                print(warning or "GPU 메모리 감시 복구", flush=True)
                self.gpu_monitoring_warning = warning
            try:
                own_rss, available = psutil.Process().memory_info().rss, psutil.virtual_memory().available
            except psutil.Error:
                complete = False
                own_rss, available = self.ledger.launcher_rss, self.ledger.available_ram
            self.ledger.sample(rss, launcher_rss=own_rss, available_ram=available, gpus=gpus, complete=complete,
                               gpu_sample_started_at=gpu_sample_started_at,
                               gpu_process_metrics_complete=process_complete)
        # Schedule every offending tree's stop before any control send can wait
        # on the network or another sender.
        await asyncio.gather(*(self.emit_terminal(worker, {
            "type": "job.error", "code": "gpu_memory_budget_exceeded",
            "detail": "GPU memory usage reached the per-device budget.",
            "vram_used_bytes": worker.vram_used_bytes, "vram_budget_bytes": worker.allocation["vram_budget_bytes"]},
            stop_immediately=True) for worker in exceeded
            if self.instances.get(worker.identity["instance_id"]) is worker and worker.terminal is None))

    async def monitor_resources(self) -> None:
        while True:
            await asyncio.sleep(self.ledger.policy.sample_interval_seconds)
            await self.sample_resources()


def process_identities(container: ProcessContainer | None) -> dict[int, float]:
    result = {}
    if container is not None:
        for pid in container.pids():
            try:
                result[pid] = psutil.Process(pid).create_time()
            except psutil.NoSuchProcess:
                continue
    return result
