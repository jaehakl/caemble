from __future__ import annotations

import asyncio
import time
from contextlib import suppress
from datetime import timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from db import SessionLocal
from gpstation.db import Job, Launcher
from gpstation.service.access_key_service import AccessKeyService
from gpstation.service.auth_audit_service import add_auth_audit
from gpstation.service.batches import finish_job, job_event, serialize_events
from gpstation.service.execution import execution_identity, locked_execution, sync_attempt, IDENTITY_FIELDS as execution_identity_fields
from gpstation.service.job_service import JOB_ACTIVE_STATES, JOB_TERMINAL_STATES, JobService
from gpstation.service.launcher_service import LauncherService
from gpstation.service.state import RuntimeRegistry, runtime, utcnow


class LauncherPolicyViolation(RuntimeError):
    pass


LAUNCHER_SEND_TIMEOUT_SECONDS = 5
RECONNECT_GRACE_SECONDS = 30


class JobOrchestrator:
    def __init__(self, registry: RuntimeRegistry = runtime) -> None:
        self.runtime = registry
        self._dispatch_wakeup = asyncio.Event()
        self._dispatcher_task = None
        self._assignment_lock = asyncio.Lock()
        self._launcher_send_locks: dict[str, asyncio.Lock] = {}

    async def start_dispatcher(self) -> None:
        if self._dispatcher_task is not None and not self._dispatcher_task.done():
            return
        self._dispatcher_task = asyncio.create_task(self._dispatch_loop(), name="job-dispatcher")
        self.wake_dispatcher()

    async def stop_dispatcher(self) -> None:
        for task in (self._dispatcher_task,):
            if task is not None:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        self._dispatcher_task = None

    def wake_dispatcher(self) -> None:
        self._dispatch_wakeup.set()

    def launcher_send_lock(self, launcher_id: str) -> asyncio.Lock:
        return self._launcher_send_locks.setdefault(launcher_id, asyncio.Lock())

    async def send_launcher_message(self, launcher_id: str, message: dict[str, Any]) -> None:
        launcher = await self.runtime.get_launcher(launcher_id)
        if launcher is None or not launcher.connected:
            raise HTTPException(404, "Launcher not available")
        await asyncio.wait_for(launcher.websocket.send_json({**message, "session_id": launcher.session_id}),
                               timeout=LAUNCHER_SEND_TIMEOUT_SECONDS)

    async def disconnect_launcher(self, launcher_id: str, *, code: int = 1011) -> None:
        launcher = await self.runtime.get_launcher(launcher_id)
        if launcher is not None:
            with suppress(Exception):
                await launcher.websocket.close(code=code)

    async def create_job(self, db, *, user_id, handler_type, slave_app_id, offer, resources=None) -> Job:
        job = await JobService.create_job(db, user_id=user_id, handler_type=handler_type,
            slave_app_id=slave_app_id, offer=offer, resources=resources)
        self.wake_dispatcher()
        return job

    async def wait_for_answer(
        self,
        db: AsyncSession,
        *,
        job_id: str,
        user_id: str | None,
        wait_seconds: float,
    ) -> Job | None:
        event = await self.runtime.prepare_job_wait(job_id)
        owns_prepared_wait = True
        try:
            job = await JobService.get_job_wait_state(db, job_id=job_id, user_id=user_id)
            should_wait = (
                job is not None
                and job.answer is None
                and job.state not in JOB_TERMINAL_STATES
                and wait_seconds > 0
            )
            if not should_wait:
                return job
            await db.commit()
            owns_prepared_wait = False
            await self.runtime.wait_prepared_job_event(job_id, event, wait_seconds)
            return await JobService.get_job_wait_state(db, job_id=job_id, user_id=user_id)
        finally:
            if owns_prepared_wait:
                await self.runtime.release_prepared_job_event(job_id, event)

    async def kill_job(self, db, *, job_id, user_id, reason, launcher_id=None, send_cancel=True):
        async with self._assignment_lock:
            job = await JobService.request_kill(db, job_id=job_id, user_id=user_id, launcher_id=launcher_id)
            if job is None:
                return None
            await self.runtime.set_job_event(job_id)
        if send_cancel and job.launcher_id and job.cleaned_at is None:
            with suppress(Exception):
                async with self.launcher_send_lock(job.launcher_id):
                    await self.send_launcher_message(job.launcher_id,
                        {"type": "job.cancel", **execution_identity(job), "reason": reason})
        self.wake_dispatcher()
        return job

    async def reset_instance(self, db, *, launcher_id: str, instance_id: str, user_id: str | None) -> bool:
        query = select(Job).where(Job.launcher_id == launcher_id, Job.instance_id == instance_id, Job.cleaned_at.is_(None))
        if user_id is not None:
            query = query.where(Job.user_id == user_id)
        job = await db.scalar(query)
        if job is None:
            return False
        await self.kill_job(db, job_id=job.id, user_id=user_id, launcher_id=launcher_id,
                            reason="instance reset by website")
        return True

    async def handle_launcher_job_event(self, db, *, launcher_id: str, user_id: str, message) -> None:
        value = message.model_dump(mode="json")
        if value.get("launcher_id") != launcher_id:
            raise LauncherPolicyViolation("event belongs to a different launcher")
        current_runtime = await self.runtime.get_launcher(launcher_id)
        if current_runtime is None or value.get("session_id") != current_runtime.session_id:
            return
        await serialize_events(db)
        owns_session = await db.scalar(select(Launcher.id).where(Launcher.id == launcher_id,
            Launcher.session_id == value["session_id"]).with_for_update())
        if owns_session is None:
            await db.commit()
            return
        kind = value["type"]
        if kind == "job.cleaned":
            from gpstation.service.worker_connection import worker_cleaned
            if await worker_cleaned(db, identity=value, user_id=user_id):
                async with self.launcher_send_lock(launcher_id):
                    await self.send_launcher_message(launcher_id, {"type": "job.cleaned.ack",
                        **{key: value[key] for key in execution_identity_fields}})
                self.wake_dispatcher()
            return
        job = await locked_execution(db, value, user_id=user_id)
        if job is None:
            await db.commit()
            # A late reply belongs to its old reservation, never to its sibling.
            if kind == "job.reserved":
                async with self.launcher_send_lock(launcher_id):
                    await self.send_launcher_message(launcher_id, {"type": "job.cancel",
                        **{key: value[key] for key in execution_identity_fields}, "reason": "stale reservation"})
            return
        if kind == "job.rejected" and (job.execution_phase == "reserving" or (job.state in JOB_TERMINAL_STATES and job.allocation is None)):
            if job.state in JOB_TERMINAL_STATES:
                job.cleaned_at, job.cleanup_state = utcnow(), "cleaned"
                await sync_attempt(db, job)
                await db.commit()
                await self.runtime.remove_instance(launcher_id, job.instance_id, job.reservation_id)
                self.wake_dispatcher()
                return
            current_runtime.rejected[job.id] = value["resource_revision"]
            old_instance, old_reservation = job.instance_id, job.reservation_id
            job.state, job.execution_phase, job.cleanup_state = "queued", "queued", None
            job.waiting_reason = value["reason"]
            job.cleaned_at = utcnow()
            await sync_attempt(db, job)
            job.launcher_id = job.instance_id = job.reservation_id = job.boot_id = None
            job.assigned_at = None
            job.worker_token_hash = None
            await job_event(db, job, "job.queued", {"waiting_reason": job.waiting_reason})
            await db.commit()
            await self.runtime.remove_instance(launcher_id, old_instance, old_reservation)
            self.wake_dispatcher()
            return
        if kind == "job.reserved":
            if job.state in JOB_TERMINAL_STATES or job.cancel_requested_at is not None:
                await db.commit()
                async with self.launcher_send_lock(launcher_id):
                    await self.send_launcher_message(launcher_id, {"type": "job.cancel", **execution_identity(job), "reason": "attempt cancelled"})
                return
            allocation = value["allocation"]
            if job.execution_phase == "reserving":
                requested = job.resources or {}
                if any(requested.get(key) is not None and requested[key] != allocation[key]
                       for key in ("cpu_cores", "startup_ram_bytes", "gpu_memory_bytes")) or (
                       requested.get("gpu_count") is not None and requested["gpu_count"] != len(allocation["gpu_devices"])):
                    await finish_job(db, job, "failed", "Launcher allocation differs from requested resources.")
                    await db.commit()
                    async with self.launcher_send_lock(launcher_id):
                        await self.send_launcher_message(launcher_id, {"type": "job.cancel", **execution_identity(job), "reason": job.last_error})
                    return
                job.allocation = allocation
                job.execution_phase = "start_authorized"
                await sync_attempt(db, job)
                await db.commit()
            else:
                await db.commit()
            if job.execution_phase == "start_authorized":
                await self._deliver_job_start(job, launcher_id)
            self.wake_dispatcher()
            return
        if job.state in JOB_TERMINAL_STATES:
            await db.commit()
            return
        if kind in {"job.error", "job.cancelled"}:
            await finish_job(db, job, "failed" if kind == "job.error" else "cancelled",
                             value.get("detail") or value.get("reason"))
        elif job.job_mode == "webrtc" and job.cancel_requested_at is not None:
            if kind in {"job.result", "job.cancelled"}:
                await finish_job(db, job, "cancelled", "Cancelled by user.")
        elif job.job_mode == "webrtc":
            if kind == "job.answer" and job.state == "assigned":
                job.answer, job.answer_ready_at, job.state = value["answer"], utcnow(), "answer_ready"
            elif kind == "job.running" and job.state == "answer_ready":
                job.state, job.execution_phase, job.started_at = "running", "running", utcnow()
            elif kind == "job.progress" and job.state == "running":
                job.progress = [*(job.progress or []), {"time": utcnow().isoformat(), "progress": value.get("progress")}]
            elif kind == "job.result" and job.state == "running":
                await finish_job(db, job, "succeeded")
        job.updated_at = utcnow()
        await sync_attempt(db, job)
        await db.commit()
        await self.runtime.set_job_event(job.id)

    async def launcher_disconnected(self, db, *, launcher_id: str, session_id: str | None = None) -> None:
        current = await self.runtime.get_launcher(launcher_id)
        if current is None:
            return
        session_id = session_id or current.session_id
        if not await self.runtime.suspend_launcher(launcher_id, session_id):
            return
        await serialize_events(db)
        launcher = await db.scalar(select(Launcher).where(Launcher.id == launcher_id,
            Launcher.session_id == session_id).with_for_update())
        if launcher is None or launcher.status == "recovering":
            await db.commit()
            return
        launcher.status = "recovering"
        launcher.reconnect_deadline = utcnow() + timedelta(seconds=RECONNECT_GRACE_SECONDS)
        jobs = list((await db.scalars(select(Job).where(Job.launcher_id == launcher_id,
            Job.state.in_(JOB_ACTIVE_STATES), Job.reservation_id.is_not(None)).with_for_update())).all())
        for job in jobs:
            job.waiting_reason = "recovering"
            await job_event(db, job, "job.recovering", {"waiting_reason": "recovering"})
        await db.commit()
        self.wake_dispatcher()

    async def reconcile_disconnected_launchers(self, db, *, connected_launcher_ids, user_id):
        # Reconciliation cannot prove remote process cleanup.
        await self._expire_reconnect_grace(db)
        return 0

    async def _expire_reconnect_grace(self, db) -> None:
        await serialize_events(db)
        sessions = dict((await db.execute(select(Launcher.id, Launcher.session_id).where(
            Launcher.reconnect_deadline.is_not(None), Launcher.reconnect_deadline < utcnow()).with_for_update())).all())
        ids = set(sessions)
        if ids:
            await JobService.disconnect_launchers_and_fail_jobs(db, launcher_ids=ids, detail="Launcher reconnect grace expired.")
            await db.execute(update(Launcher).where(Launcher.id.in_(ids)).values(reconnect_deadline=None))
            await db.commit()
            for launcher_id in ids:
                await self.runtime.remove_launcher(launcher_id, sessions[launcher_id])

    async def reconcile_pending_assignments(self, db, *, launcher_id: str, boot_id: str, session_id: str) -> None:
        """Replay uncertain commands against the same reservation, including on a live socket."""
        current = await self.runtime.get_launcher(launcher_id)
        if current is None or current.session_id != session_id or current.boot_id != boot_id:
            return
        jobs = list((await db.scalars(select(Job).where(Job.launcher_id == launcher_id,
            Job.boot_id == boot_id, Job.state.in_(JOB_ACTIVE_STATES),
            Job.execution_phase.in_(("reserving", "start_authorized")), Job.cancel_requested_at.is_(None)))).all())
        await db.commit()
        for job in jobs:
            if time.monotonic() - current.last_command_at.get(job.reservation_id, 0) < 5:
                continue
            if not await self.runtime.session_matches(launcher_id, session_id):
                return
            if job.execution_phase == "reserving":
                await self._deliver_reservation(job, launcher_id)
            else:
                await self._deliver_job_start(job, launcher_id)

    async def reconcile_launcher(self, db, *, launcher_id, user_id, hello) -> None:
        from sdk.protocol.messages import JobCleaned, parse_launcher_message
        current = await self.runtime.get_launcher(launcher_id)
        if current is None or current.session_id != hello.session_id:
            return
        for receipt in hello.cleanup_receipts:
            terminal = receipt.get("terminal")
            if isinstance(terminal, dict) and all(terminal.get(key) == receipt.get(key) for key in execution_identity_fields):
                await self.handle_launcher_job_event(db, launcher_id=launcher_id, user_id=user_id,
                    message=parse_launcher_message({**terminal, "session_id": hello.session_id}))
            await self.handle_launcher_job_event(db, launcher_id=launcher_id, user_id=user_id,
                message=JobCleaned.model_validate({**receipt, "type": "job.cleaned", "session_id": hello.session_id}))
        jobs = list((await db.scalars(select(Job).where(Job.launcher_id == launcher_id,
            Job.reservation_id.is_not(None), Job.cleaned_at.is_(None)))).all())
        inventory = {item.get("reservation_id"): item for item in hello.instances}
        for job in jobs:
            present = inventory.get(job.reservation_id)
            if job.boot_id != hello.boot_id:
                if job.state not in JOB_TERMINAL_STATES:
                    identity = execution_identity(job)
                    await serialize_events(db)
                    owns_session = await db.scalar(select(Launcher.id).where(Launcher.id == launcher_id,
                        Launcher.session_id == hello.session_id).with_for_update())
                    if owns_session is None:
                        await db.commit()
                        return
                    active = await locked_execution(db, identity, user_id=user_id)
                    if active is not None:
                        await finish_job(db, active, "failed", "Launcher process restarted; awaiting prior process cleanup.")
                    await db.commit()
                continue
            if present is None:
                if job.execution_phase == "reserving":
                    await self._deliver_reservation(job, launcher_id)
                    continue
                # A complete same-boot inventory proves this instance is absent.
                await self.handle_launcher_job_event(db, launcher_id=launcher_id, user_id=user_id,
                    message=JobCleaned.model_validate({"type": "job.cleaned", **execution_identity(job), "session_id": hello.session_id}))
            elif any(present.get(key) != value for key, value in execution_identity(job).items()) or job.state in JOB_TERMINAL_STATES or job.cancel_requested_at:
                async with self.launcher_send_lock(launcher_id):
                    await self.send_launcher_message(launcher_id, {"type": "job.cancel", **execution_identity(job), "reason": "attempt is no longer active"})
            elif job.execution_phase == "reserving":
                await self._deliver_reservation(job, launcher_id)
            elif job.execution_phase == "start_authorized":
                await self._deliver_job_start(job, launcher_id)
        known = {job.reservation_id for job in jobs}
        for item in hello.instances:
            if item.get("reservation_id") not in known:
                async with self.launcher_send_lock(launcher_id):
                    await self.send_launcher_message(launcher_id, {"type": "job.cancel",
                        **{key: item[key] for key in execution_identity_fields}, "reason": "unrecognized reservation"})
        await serialize_events(db)
        owns_session = await db.scalar(select(Launcher.id).where(Launcher.id == launcher_id,
            Launcher.session_id == hello.session_id).with_for_update())
        if owns_session is None:
            await db.commit()
            return
        resumed = list((await db.scalars(select(Job).where(Job.launcher_id == launcher_id,
            Job.boot_id == hello.boot_id, Job.state.in_(JOB_ACTIVE_STATES),
            Job.waiting_reason == "recovering").with_for_update())).all())
        for job in resumed:
            job.waiting_reason = None
            await job_event(db, job, "job.resumed", {"waiting_reason": None})
        await db.commit()
        current.recovering = False
        self.wake_dispatcher()

    async def dispatch_available_jobs(self) -> int:
        dispatched = 0
        while True:
            async with self._assignment_lock:
                available = await self.runtime.available_launchers()
                if not available:
                    break
                async with SessionLocal() as db:
                    assignment = await JobService.claim_next_compatible_job(db, available_launchers=available)
                if assignment is None:
                    break
                job, launcher_id = assignment
                await self.runtime.mark_instance(launcher_id, {**execution_identity(job), "state": "reserving",
                                                               "slave_app_id": job.slave_app_id})
            await self._deliver_reservation(job, launcher_id)
            dispatched += 1
        return dispatched

    async def _deliver_reservation(self, job, launcher_id) -> None:
        current = await self.runtime.get_launcher(launcher_id)
        if current is not None:
            current.last_command_at[job.reservation_id] = time.monotonic()
        with suppress(Exception):
            async with self.launcher_send_lock(launcher_id):
                await self.send_launcher_message(launcher_id, {"type": "job.reserve", **execution_identity(job),
                    "handler_type": job.handler_type, "slave_app_id": job.slave_app_id,
                    "job_mode": job.job_mode, "resources": job.resources or {}})

    async def _deliver_job_start(self, job, launcher_id) -> None:
        launcher = await self.runtime.get_launcher(launcher_id)
        if launcher is not None:
            launcher.last_command_at[job.reservation_id] = time.monotonic()
        async with self.launcher_send_lock(launcher_id):
            async with SessionLocal() as db:
                current = await locked_execution(db, execution_identity(job))
                if current is None or current.cancel_requested_at or current.state in JOB_TERMINAL_STATES:
                    return
                if current.job_mode == "websocket":
                    from gpstation.service.worker_connection import worker_assignment
                    message = await worker_assignment(db, current)
                else:
                    message = {"type": "job.start", **execution_identity(current), "handler_type": current.handler_type,
                        "slave_app_id": current.slave_app_id, "job_mode": "webrtc", "offer": current.offer,
                        "allocation": current.allocation}
                    await db.commit()
            await self.runtime.mark_instance(launcher_id, {**execution_identity(job), "state": "starting",
                "slave_app_id": job.slave_app_id, "allocation": job.allocation})
            await self.send_launcher_message(launcher_id, message)

    async def _expire_stale_jobs(self) -> None:
        async with SessionLocal() as db:
            await self._expire_reconnect_grace(db)
            jobs = await JobService.expire_stale_jobs(db)
        for job in jobs:
            await self.runtime.set_job_event(job.id)
            if job.launcher_id and job.reservation_id:
                with suppress(Exception):
                    async with self.launcher_send_lock(job.launcher_id):
                        await self.send_launcher_message(job.launcher_id,
                            {"type": "job.cancel", **execution_identity(job), "reason": job.last_error or "job expired"})

    async def revalidate_launcher_access_keys(self) -> int:
        targets = await self.runtime.access_key_revalidation_targets()
        if not targets:
            return 0
        async with SessionLocal() as db:
            active_key_ids = await AccessKeyService.active_launcher_key_ids(
                db,
                {access_key_id for _, access_key_id in targets},
            )
            await db.commit()
            await self.runtime.mark_access_keys_revalidated(
                {launcher_id for launcher_id, _ in targets}
            )
            invalid_launcher_ids = {
                launcher_id
                for launcher_id, access_key_id in targets
                if access_key_id not in active_key_ids
            }
            for launcher_id in invalid_launcher_ids:
                await self.disconnect_launcher(launcher_id, code=1008)
                access_key_id = next(
                    key_id
                    for target_launcher_id, key_id in targets
                    if target_launcher_id == launcher_id
                )
                add_auth_audit(
                    db,
                    "launcher_rejected",
                    details={
                        "reason": "access_key_inactive",
                        "launcher_id": launcher_id,
                        "access_key_id": access_key_id,
                    },
                )
            failed_jobs = await JobService.disconnect_launchers_and_fail_jobs(
                db,
                launcher_ids=invalid_launcher_ids,
                detail="launcher access key is no longer active",
            )
        for job in failed_jobs:
            await self.runtime.set_job_event(str(job.id))
        if invalid_launcher_ids:
            self.wake_dispatcher()
        return len(invalid_launcher_ids)

    async def _dispatch_loop(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self._dispatch_wakeup.wait(), timeout=1)
            except TimeoutError:
                pass
            self._dispatch_wakeup.clear()
            try:
                await self.revalidate_launcher_access_keys()
                await self._expire_stale_jobs()
                await self.dispatch_available_jobs()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                print(f"job dispatcher failed: {type(error).__name__}", flush=True)


job_orchestrator = JobOrchestrator()
